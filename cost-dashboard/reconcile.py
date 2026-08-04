"""Replace nominal gateway costs with what the gateway actually billed.

A transaction carrying `routedVia` was served through a user endpoint profile,
so its `tokenValue` is nominal: priced from LibreChat's model-name rate table,
which describes what the provider would have charged rather than what the
gateway did. For Surplus Intelligence the real figure is knowable after the
fact — `/v1/buyer/usage/export` returns one settled row per request with both
`buyer_cost_usd` (paid) and `direct_cost_usd` (provider list price).

This module pulls that export on a timer and writes a `reconciled` sub-document
onto the matching transactions. The original `tokenValue` is left untouched: it
stays the nominal figure, and the dashboard prefers `reconciled.costUSD` when
present. Nothing here destroys data, so a bad match can be undone by clearing
the field and re-running.

Matching is heuristic. The export's `request_id` is a settlement id and does NOT
equal the `x-request-id` header returned to the caller, so there is no shared
key to join on. Requests are instead paired by (model, output tokens) within a
time window — output tokens are exact and cache-independent, unlike input
tokens, which the Anthropic-compatible path reports net of cache. Where several
identical requests fall in the same window the nearest in time wins and the
result is flagged `ambiguous`; their costs differ only by whatever seller prices
moved in between.
"""

import csv
import io
import os
import threading
import time
from datetime import datetime, timedelta, timezone
import requests

from routing import RECONCILABLE_HOSTS, host_of

SURPLUS_API_BASE = os.environ.get(
    "SURPLUS_API_BASE", "https://api.surplusintelligence.ai"
).rstrip("/")
SURPLUS_API_KEY = os.environ.get("SURPLUS_API_KEY", "").strip()

#: Hosts whose spend this reconciler is able to settle. Shared with the
#: dashboard, which uses the same list to decide what is awaiting settlement.
SURPLUS_HOSTS = RECONCILABLE_HOSTS

#: How long after a request LibreChat may write its transaction. A transaction is
#: stamped when the stream finishes, the export row when the request arrived, so
#: the export timestamp always precedes it by the generation duration.
MAX_LAG = timedelta(seconds=int(os.environ.get("SURPLUS_MATCH_LAG", "1800")))
#: Tolerance in the other direction, purely for clock skew between hosts.
MAX_LEAD = timedelta(seconds=120)

INTERVAL = int(os.environ.get("SURPLUS_RECONCILE_INTERVAL", "3600"))

MICRO_PER_USD = 1_000_000


def is_surplus_url(url):
    """Whether a `routedVia.baseURL` points at a gateway this module can settle."""
    return host_of(url) in SURPLUS_HOSTS


def fetch_usage_rows(session=None):
    """Download the buyer usage export and return it as a list of dicts.

    The endpoint 302s to a pre-signed S3 URL. `requests` drops the Authorization
    header when a redirect crosses hosts, which is both required (S3 rejects it)
    and the reason the key never reaches AWS.
    """
    if not SURPLUS_API_KEY:
        raise RuntimeError("SURPLUS_API_KEY is not set")

    session = session or requests.Session()
    response = session.get(
        f"{SURPLUS_API_BASE}/v1/buyer/usage/export",
        headers={"Authorization": f"Bearer {SURPLUS_API_KEY}"},
        timeout=60,
    )
    response.raise_for_status()
    return list(csv.DictReader(io.StringIO(response.text)))


def _parse_ts(value):
    """Parse the export's ISO-8601 timestamps into aware UTC datetimes."""
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _as_float(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _as_int(value):
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return 0


def load_pending_groups(transactions):
    """Unreconciled Surplus-routed transactions, grouped per model request.

    A single API call produces one `prompt` and one `completion` transaction
    sharing a `messageId`; the export has one row for the pair, so matching
    happens per group rather than per transaction.

    `context` is part of the key because one user message can trigger several
    calls that all carry the same `messageId` — the reply itself is `message`,
    the auto-generated conversation title is `title`. They are separate requests
    with separate billing rows, and grouping them together would produce a token
    count matching neither.
    """
    cursor = transactions.find(
        {
            "routedVia.baseURL": {"$exists": True},
            "reconciled": {"$exists": False},
            "tokenType": {"$in": ["prompt", "completion"]},
        },
        {
            "_id": 1,
            "messageId": 1,
            "model": 1,
            "context": 1,
            "tokenType": 1,
            "tokenValue": 1,
            "rawAmount": 1,
            "createdAt": 1,
            "routedVia": 1,
        },
    )

    groups = {}
    for doc in cursor:
        if not is_surplus_url((doc.get("routedVia") or {}).get("baseURL")):
            continue
        # Transactions predating messageId, or written without one, can still be
        # settled individually — their own id keeps them in a group of one.
        key = (
            doc.get("messageId") or str(doc["_id"]),
            doc.get("context"),
            doc.get("model"),
        )
        group = groups.setdefault(
            key,
            {
                "model": doc.get("model"),
                "docs": [],
                "out_tokens": 0,
                "in_tokens": 0,
                "at": None,
                "nominal_micro": 0.0,
            },
        )
        group["docs"].append(doc)
        tokens = abs(doc.get("rawAmount") or 0)
        if doc.get("tokenType") == "completion":
            group["out_tokens"] += tokens
        else:
            group["in_tokens"] += tokens
        group["nominal_micro"] += abs(doc.get("tokenValue") or 0)

        created = doc.get("createdAt")
        if created is not None:
            if created.tzinfo is None:
                created = created.replace(tzinfo=timezone.utc)
            if group["at"] is None or created > group["at"]:
                group["at"] = created

    return [g for g in groups.values() if g["at"] is not None]


def _index_rows(rows):
    """Bucket export rows by the fields used to identify a request."""
    index = {}
    for row in rows:
        at = _parse_ts(row.get("created_at"))
        if at is None:
            continue
        entry = {
            "request_id": row.get("request_id"),
            "model": row.get("model"),
            "at": at,
            "in_tokens": _as_int(row.get("input_tokens")),
            "out_tokens": _as_int(row.get("output_tokens")),
            "cost": _as_float(row.get("buyer_cost_usd")),
            "direct": _as_float(row.get("direct_cost_usd")),
            "status": row.get("settlement_status"),
            "tx_hash": row.get("tx_hash"),
        }
        index.setdefault((entry["model"], entry["out_tokens"]), []).append(entry)
    return index


def match_groups(groups, rows):
    """Pair transaction groups with export rows. Returns (matches, unmatched).

    Assignment is greedy by time distance so the closest pairing is made first
    and each export row is consumed once — otherwise a burst of identical title
    generations would all latch onto whichever row happened to be scanned first.
    """
    index = _index_rows(rows)
    used = set()

    candidates = []
    for group in groups:
        for entry in index.get((group["model"], group["out_tokens"]), []):
            delta = group["at"] - entry["at"]
            if -MAX_LEAD <= delta <= MAX_LAG:
                candidates.append((abs(delta.total_seconds()), group, entry))

    candidates.sort(key=lambda c: c[0])

    matches = []
    claimed = set()
    contested = {}
    for _, group, entry in candidates:
        contested[id(group)] = contested.get(id(group), 0) + 1

    for _, group, entry in candidates:
        if id(group) in claimed or entry["request_id"] in used:
            continue
        claimed.add(id(group))
        used.add(entry["request_id"])
        matches.append((group, entry, contested.get(id(group), 1) > 1))

    unmatched = [g for g in groups if id(g) not in claimed]
    return matches, unmatched


def apply_match(transactions, group, entry, ambiguous, now=None):
    """Write the settled cost onto every transaction in a matched group.

    The export prices the whole request, so the figure is split across the
    group's transactions in proportion to their nominal values — that keeps the
    prompt/completion split meaningful and makes the parts sum to the total.
    Groups with no nominal value fall back to a token-count split.
    """
    now = now or datetime.now(timezone.utc)
    docs = group["docs"]

    weights = [abs(doc.get("tokenValue") or 0) for doc in docs]
    if sum(weights) <= 0:
        weights = [abs(doc.get("rawAmount") or 0) for doc in docs]
    if sum(weights) <= 0:
        weights = [1] * len(docs)
    total_weight = sum(weights)

    updates = 0
    for doc, weight in zip(docs, weights):
        share = weight / total_weight
        transactions.update_one(
            {"_id": doc["_id"]},
            {
                "$set": {
                    "reconciled": {
                        "source": "surplus",
                        "requestId": entry["request_id"],
                        "costUSD": entry["cost"] * share,
                        "directUSD": entry["direct"] * share,
                        "requestCostUSD": entry["cost"],
                        "requestDirectUSD": entry["direct"],
                        "settlementStatus": entry["status"],
                        "txHash": entry["tx_hash"],
                        "ambiguous": bool(ambiguous),
                        "at": now,
                    }
                }
            },
        )
        updates += 1
    return updates


def run_once(transactions, session=None):
    """One reconciliation pass. Returns a summary dict for logging and /cost.

    Every path records the outcome, so the status line on /cost reflects the
    most recent pass whether it came from the timer or a manual trigger.
    """
    started = datetime.now(timezone.utc)
    if not SURPLUS_API_KEY:
        return _record({"ok": False, "error": "SURPLUS_API_KEY is not set", "at": started})

    try:
        rows = fetch_usage_rows(session)
    except Exception as exc:  # network, auth, malformed CSV
        return _record({"ok": False, "error": f"{type(exc).__name__}: {exc}", "at": started})

    groups = load_pending_groups(transactions)
    matches, unmatched = match_groups(groups, rows)

    updated = 0
    ambiguous = 0
    for group, entry, is_ambiguous in matches:
        updated += apply_match(transactions, group, entry, is_ambiguous, now=started)
        ambiguous += 1 if is_ambiguous else 0

    return _record(
        {
            "ok": True,
            "at": started,
            "export_rows": len(rows),
            "pending_groups": len(groups),
            "matched": len(matches),
            "ambiguous": ambiguous,
            "transactions_updated": updated,
            "unmatched": len(unmatched),
        }
    )


_last_run = {"ok": None, "at": None, "note": "not run yet"}


def _record(result):
    _last_run.clear()
    _last_run.update(result)
    return result


def last_run():
    return dict(_last_run)


def start_scheduler(transactions):
    """Background reconciliation loop. No-op without a key, so the dashboard
    still runs unconfigured — it simply reports gateway spend as nominal."""
    if not SURPLUS_API_KEY:
        _record({"ok": False, "at": None, "note": "SURPLUS_API_KEY is not set"})
        print("[reconcile] disabled: SURPLUS_API_KEY is not set", flush=True)
        return None

    def loop():
        session = requests.Session()
        while True:
            try:
                result = run_once(transactions, session)
            except Exception as exc:
                result = _record({"ok": False, "error": f"{type(exc).__name__}: {exc}"})
            print(f"[reconcile] {result}", flush=True)
            time.sleep(INTERVAL)

    thread = threading.Thread(target=loop, name="surplus-reconcile", daemon=True)
    thread.start()
    print(f"[reconcile] scheduled every {INTERVAL}s", flush=True)
    return thread
