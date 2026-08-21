"""Surplus Intelligence buyer-account state: balance, lifetime spend, savings.

The dashboard has visibility into what LibreChat *recorded* spending (nominal,
from the model-name table, per `routing.py`) but no visibility into the buyer
account itself — wallet balance, credit balance, or the discount actually
realized versus direct-provider pricing. Two authenticated upstream endpoints
cover that:

    GET /v1/buyer/me       wallet/credit balances, lifetime stats, per-model
                            spend breakdown
    GET /v1/buyer/savings  lifetime + daily-bucketed savings vs. direct price

Both are proxied here, merged into one trimmed response, cached in-process for
60 s (this is account state — it moves far slower than the market table's
30 s), and converted out of microdollars exactly once, at the boundary.

Unlike `markets.py`, these calls are authenticated with `SURPLUS_API_KEY` —
the same env var and base URL `reconcile.py` uses, read the same way. Without
a key configured, the route returns 200 with `{"configured": false}` rather
than erroring, mirroring how `reconcile.py` degrades when the key is absent:
the dashboard must render fine either way.
"""

import os
import threading
import time
from datetime import datetime, timezone

import requests
from flask import Blueprint, jsonify

from reconcile import SURPLUS_API_BASE, SURPLUS_API_KEY

CACHE_TTL = 60

MICRO_PER_USD = 1_000_000

bp = Blueprint("buyer", __name__)

_cache = {"snapshot": None, "fetched_at": None, "expires": 0.0}
_cache_lock = threading.Lock()


def _usd(micro):
    """Micro-USD (str or int/float, as the upstream sends either) → dollars.

    `me`'s balance fields arrive as strings, its stats and `savings`'s figures
    arrive as ints; both are handled the same way here. Missing/unparseable
    values become 0.0 — an account field, unlike a market price, has no
    "not published" state to preserve as None.
    """
    if micro is None:
        return 0.0
    try:
        return float(micro) / MICRO_PER_USD
    except (TypeError, ValueError):
        return 0.0


def _fetch_json(path, session, params=None):
    response = (session or requests).get(
        f"{SURPLUS_API_BASE}{path}",
        headers={"Authorization": f"Bearer {SURPLUS_API_KEY}"},
        params=params,
        timeout=30,
    )
    response.raise_for_status()
    return response.json()


def _fetch_snapshot(session=None):
    """`(me, savings)` upstream payloads, at most one pair of hits per TTL.

    The two calls are independent: a failure fetching one does not block the
    other. Whichever raised is folded into the merge as an empty dict, so the
    route can still return the fields the surviving call provided.

    A failed refresh serves the previous snapshot rather than erroring, same
    as `markets.py` — staleness is visible in `fetchedAt`.
    """
    with _cache_lock:
        now = time.monotonic()
        if _cache["snapshot"] is not None and now < _cache["expires"]:
            return _cache["snapshot"], _cache["fetched_at"]

        try:
            me = _fetch_json("/v1/buyer/me", session)
        except Exception:
            me = None
        try:
            savings = _fetch_json("/v1/buyer/savings", session, params={"period": "daily"})
        except Exception:
            savings = None

        if me is None and savings is None:
            if _cache["snapshot"] is not None:
                return _cache["snapshot"], _cache["fetched_at"]
            raise RuntimeError("both /v1/buyer/me and /v1/buyer/savings failed")

        snapshot = (me or {}, savings or {})
        _cache["snapshot"] = snapshot
        _cache["fetched_at"] = datetime.now(timezone.utc).isoformat()
        _cache["expires"] = now + CACHE_TTL
        return snapshot, _cache["fetched_at"]


def _per_model(model_breakdown, savings_breakdown):
    """Join `me.model_breakdown` with `savings.breakdown` on model name.

    Either side may be missing a model the other has — a model with no
    upstream discount data yet, or one dropped from stats after a rename. The
    join is a full outer join on model name so no row is silently lost; the
    side without data reports zeros.
    """
    spend_by_model = {row["model"]: row for row in model_breakdown or [] if row.get("model")}
    savings_by_model = {row["model"]: row for row in savings_breakdown or [] if row.get("model")}

    rows = []
    for model in set(spend_by_model) | set(savings_by_model):
        spend = spend_by_model.get(model, {})
        saved = savings_by_model.get(model, {})
        rows.append(
            {
                "model": model,
                "spent": _usd(spend.get("spent")),
                "direct": _usd(spend.get("direct_spent")),
                "saved": _usd(saved.get("saved")),
                "discountPct": saved.get("discount"),
                "requests": spend.get("requests") or 0,
                "inputTokens": spend.get("input_tokens") or 0,
                "outputTokens": spend.get("output_tokens") or 0,
            }
        )
    return sorted(rows, key=lambda r: r["spent"], reverse=True)


def _buckets(raw_buckets):
    return [
        {
            "period": b.get("period"),
            "spent": _usd(b.get("total_actual_usdc")),
            "direct": _usd(b.get("total_direct_usdc")),
            "saved": _usd(b.get("total_saved_usdc")),
            "savingsPct": b.get("savings_pct"),
            "requests": b.get("request_count") or 0,
        }
        for b in raw_buckets or []
    ]


def _merge(me, savings, fetched_at):
    stats = me.get("stats") or {}
    summary = savings.get("summary") or {}
    return {
        "configured": True,
        "creditBalance": _usd(me.get("credit_balance_usdc")),
        "balance": _usd(me.get("balance_usdc")),
        "allowance": _usd(me.get("allowance_usdc")),
        "spent": _usd(stats.get("total_spent")),
        "requests": stats.get("total_requests") or 0,
        "inputTokens": stats.get("total_input_tokens") or 0,
        "outputTokens": stats.get("total_output_tokens") or 0,
        "savedUSD": _usd(summary.get("total_saved_usdc")),
        "directUSD": _usd(summary.get("total_direct_usdc")),
        # Defaulted rather than left None: the savings call can fail on its own
        # while /me succeeds, and a consumer formatting this as a percentage
        # should get "0%" for "we could not ask", not a crash.
        "savingsPct": summary.get("savings_pct") or 0.0,
        "requestCount": summary.get("request_count") or 0,
        "perModel": _per_model(me.get("model_breakdown"), savings.get("breakdown")),
        "buckets": _buckets(savings.get("buckets")),
        "fetchedAt": fetched_at,
    }


@bp.route("/cost/buyer")
def buyer():
    if not SURPLUS_API_KEY:
        return jsonify({"configured": False})
    try:
        (me, savings), fetched_at = _fetch_snapshot()
    except Exception as exc:
        return jsonify({"error": f"{type(exc).__name__}: {exc}"}), 502
    return jsonify(_merge(me, savings, fetched_at))


def summary():
    """The same payload for server-side rendering, but it never raises.

    `/cost` is the dashboard's one page and it has to render when the
    marketplace is unreachable, unconfigured, or simply slow — none of which say
    anything about the MongoDB-derived spend that makes up the rest of it. The
    caller gets `configured: False` and omits the panel.
    """
    if not SURPLUS_API_KEY:
        return {"configured": False}
    try:
        (me, savings), fetched_at = _fetch_snapshot()
        return _merge(me, savings, fetched_at)
    except Exception as exc:
        return {"configured": False, "error": f"{type(exc).__name__}: {exc}"}
