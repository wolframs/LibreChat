"""Live Surplus marketplace prices, trimmed for the chat header popup.

The upstream table (`GET {SURPLUS_API_BASE}/api/markets`) is public and
unauthenticated, but it cannot be fetched from the browser: the response
carries no CORS headers, and at 853 KB across ~340 rows it is far too heavy
to ship per popup open anyway. So this module proxies it — cached in-process
for the 30 s the upstream's own `cache-control` allows, trimmed to one model,
and converted out of microdollars exactly once, here.

Everything served under `/cost` is unauthenticated behind nginx. That is
acceptable for this data only because it is public at the source; do not add
anything here that isn't.

The headline discount is computed from the blended best offer against the
blended list price rather than passed through: the upstream `best_discount_pct`
is the single deepest offer on the book (routinely 99.99% from near-zero
listings) and would be misleading as a summary. `discount_trend`, by contrast,
reflects discounts on requests that actually happened, so it is passed through.

The list price in that denominator is the provider's, not the marketplace's
own `direct_*_per_1m` reference — see `listprices.py` for why those differ and
which one the payload says it used.
"""

import os
import threading
import time
from datetime import datetime, timezone

import requests
import yaml
from flask import Blueprint, jsonify, request

from listprices import list_price
from reconcile import SURPLUS_API_BASE
from routing import RECONCILABLE_HOSTS, host_of

#: Hosts whose custom-endpoint rows should show the market-price button. The
#: same set the reconciler settles against — a second marketplace joins both
#: behaviours by joining `routing.py`, nothing here.
MARKETPLACE_HOSTS = RECONCILABLE_HOSTS

#: Bind-mounted read-only from the repo root (docker-compose.override.yml).
LIBRECHAT_YAML = os.environ.get("LIBRECHAT_YAML", "/app/librechat.yaml")

#: Matches the upstream `cache-control: public, max-age=30`.
CACHE_TTL = 30

MICRO_PER_USD = 1_000_000

bp = Blueprint("markets", __name__)

_cache = {"rows": None, "fetched_at": None, "expires": 0.0}
_cache_lock = threading.Lock()


def _fetch_rows(session=None):
    """The markets table as {model: row}, at most one upstream hit per TTL.

    A failed refresh serves the previous snapshot rather than erroring: a
    stale price beats no price for a readout, and the staleness is visible in
    `fetchedAt`.
    """
    with _cache_lock:
        now = time.monotonic()
        if _cache["rows"] is not None and now < _cache["expires"]:
            return _cache["rows"], _cache["fetched_at"]
        try:
            response = (session or requests).get(
                f"{SURPLUS_API_BASE}/api/markets", timeout=15
            )
            response.raise_for_status()
            markets = response.json().get("markets") or []
        except Exception:
            if _cache["rows"] is not None:
                return _cache["rows"], _cache["fetched_at"]
            raise
        _cache["rows"] = {r["model"]: r for r in markets if r.get("model")}
        _cache["fetched_at"] = datetime.now(timezone.utc).isoformat()
        _cache["expires"] = now + CACHE_TTL
        return _cache["rows"], _cache["fetched_at"]


def _usd(micro):
    """Micro-dollars per 1M tokens → dollars per 1M tokens. 0 and None both
    mean "not published" upstream, and both become None here."""
    if not micro:
        return None
    return micro / MICRO_PER_USD


def _reference(row):
    """The list price the discount is measured against, and its provenance.

    `source: "provider"` means the fork's own rate table had an exact entry for
    this model — the same rate a direct request would have been billed at.
    `source: "marketplace"` means it did not, and this is the marketplace's own
    published reference. The marketplace pair is carried either way so the
    popup can show what it would otherwise have claimed.

    Which seller that reference was taken from is *not* carried: the per-offer
    rows name it (`reference_source`, "venice" on every `claude-fable-5` offer
    on 2026-08-21), but this aggregate table doesn't publish the field, and
    fetching the detail endpoint per popup open to recover one label is not
    worth 244 rows.
    """
    ours = list_price(row.get("model"))
    theirs = {
        "marketplaceInput": _usd(row.get("direct_input_per_1m")),
        "marketplaceOutput": _usd(row.get("direct_output_per_1m")),
    }
    if ours is not None:
        return {"input": ours[0], "output": ours[1], "source": "provider", **theirs}
    return {
        "input": theirs["marketplaceInput"],
        "output": theirs["marketplaceOutput"],
        "source": "marketplace",
        **theirs,
    }


def _blended_discount(row, reference):
    """Percent saved on (1M in + 1M out) at the best offers vs list, or None
    when there is no list price to compare against."""
    best = row.get("best_price_per_1m")
    direct = (reference.get("input") or 0) + (reference.get("output") or 0)
    if not best or not direct:
        return None
    return round((1 - (best / MICRO_PER_USD) / direct) * 100, 1)


def _trend(row):
    trend = row.get("discount_trend") or {}
    buckets = sorted(trend.get("buckets") or [], key=lambda b: b.get("bucket", 0))
    if not buckets:
        return None
    return {
        "direction": trend.get("direction"),
        "currentPct": trend.get("current_discount_pct"),
        "previousPct": trend.get("previous_discount_pct"),
        "buckets": [b.get("discount_pct") for b in buckets],
    }


def _sellers(row):
    providers = row.get("providers") or []
    trimmed = [
        {
            "provider": p.get("provider"),
            "trusted": bool(p.get("trusted")),
            "healthy": p.get("healthy_seller_count") or 0,
            "input": _usd(p.get("best_input_per_1m")),
            "output": _usd(p.get("best_output_per_1m")),
        }
        for p in providers
    ]
    return sorted(trimmed, key=lambda p: (p["input"] is None, p["input"] or 0))


def _trim(row, fetched_at):
    reference = _reference(row)
    return {
        "model": row["model"],
        "best": {
            "input": _usd(row.get("best_input_per_1m")),
            "output": _usd(row.get("best_output_per_1m")),
            "cacheRead": _usd(row.get("best_cache_read_per_1m")),
            "cacheWrite": _usd(row.get("best_cache_write_per_1m")),
        },
        "direct": reference,
        "discountPct": _blended_discount(row, reference),
        "trend": _trend(row),
        "sellers": _sellers(row),
        "healthySellers": row.get("healthy_seller_count") or 0,
        "requests24h": row.get("requests_24h") or 0,
        "fetchedAt": fetched_at,
    }


def _summary(row):
    """One line per model, for the bare (future "all models") route."""
    return {
        "model": row["model"],
        "bestInput": _usd(row.get("best_input_per_1m")),
        "bestOutput": _usd(row.get("best_output_per_1m")),
        "discountPct": _blended_discount(row, _reference(row)),
        "healthySellers": row.get("healthy_seller_count") or 0,
    }


_yaml_cache = {"mtime": None, "names": []}


def marketplace_endpoint_names(path=None):
    """Names of `endpoints.custom` rows whose baseURL is a known marketplace.

    Reads the same bind-mounted `librechat.yaml` the api container uses, so a
    renamed or added row is picked up without touching this sidecar. Missing
    or unparseable yaml yields an empty list — the button simply never shows,
    which the deploy checklist's browser pass would catch.
    """
    path = path or LIBRECHAT_YAML
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        return []
    if _yaml_cache["mtime"] == mtime:
        return _yaml_cache["names"]
    try:
        with open(path, encoding="utf-8") as fh:
            config = yaml.safe_load(fh) or {}
        rows = ((config.get("endpoints") or {}).get("custom")) or []
        names = [
            r["name"]
            for r in rows
            if isinstance(r, dict)
            and r.get("name")
            and host_of(r.get("baseURL")) in MARKETPLACE_HOSTS
        ]
    except Exception:
        return []
    _yaml_cache["mtime"] = mtime
    _yaml_cache["names"] = names
    return names


@bp.route("/cost/markets")
def markets():
    model = request.args.get("model")
    try:
        rows, fetched_at = _fetch_rows()
    except Exception as exc:
        return jsonify({"error": f"{type(exc).__name__}: {exc}"}), 502
    if model is None:
        return jsonify(
            {
                "markets": [_summary(r) for r in rows.values()],
                "fetchedAt": fetched_at,
            }
        )
    row = rows.get(model)
    if row is None:
        return jsonify({"error": "model not in markets table", "model": model}), 404
    return jsonify(_trim(row, fetched_at))


@bp.route("/cost/markets/endpoints")
def markets_endpoints():
    return jsonify({"endpoints": marketplace_endpoint_names()})
