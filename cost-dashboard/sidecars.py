"""Spend that never touches `transactions`: the MCP tool sidecars.

Two tools on this stack pay for models on their own server-wide keys and keep
their own ledgers — `mcp-image-gen` in `mcp_image_gen_usage`, `mcp-audio-ears`
in `mcp_audio_ears_usage`. Neither writes a `transactions` row (no endpoint, no
model rate, no `routedVia`), so until 2026-09-08 a day of image generation
reported as zero on `/cost`. This module reads both ledgers and hands the
dashboard two things: a dollar figure per period to fold into the summary
cards, and a per-model table with the same three confidence states the
transaction tables use.

Each ledger prices a row a different way, and the row says which:

  image, OpenRouter   `cost` is OpenRouter's own settled figure from the response  — reported
  image, Surplus      `cost` is null; `listCost` is the catalogue price at request time,
                      and `reconciled.costUSD` is the marketplace's settled charge once
                      the hourly export has been matched (reconcile.py)          — settled / list
  audio               `cost` is OpenRouter's settled figure, summed over chunks   — reported

so the effective cost of a row is `reconciled.costUSD ?? cost ?? listCost ?? 0`,
in that order. List is ~3x settled on Surplus, so an unmatched row over-counts
rather than under-counts, and the table tags it `list` so it is never mistaken
for a billed figure.

Rows older than the provider field (before 2026-09-08) carry no `provider`; the
model id decides — `vendor/name` is OpenRouter's shape, a bare name is Surplus's.
"""

from datetime import datetime, timezone

#: Effective dollars for one image row. Tested against "missing" rather than
#: truthiness, as app.py does, because a settled 0 is a real value.
IMAGE_EFFECTIVE_USD = {
    "$ifNull": [
        "$reconciled.costUSD",
        {"$ifNull": ["$cost", {"$ifNull": ["$listCost", 0]}]},
    ]
}

HAS_RECONCILED = {"$ne": [{"$type": "$reconciled.costUSD"}, "missing"]}
HAS_REPORTED = {"$ne": [{"$type": "$cost"}, "missing"]}

#: `provider` for rows written before the field existed.
IMAGE_PROVIDER = {
    "$ifNull": [
        "$provider",
        {
            "$cond": [
                {"$regexMatch": {"input": {"$ifNull": ["$model", ""]}, "regex": "/"}},
                "openrouter",
                "surplus",
            ]
        },
    ]
}

AUDIO_EFFECTIVE_USD = {"$ifNull": ["$cost", 0]}


def _match(since):
    return {"createdAt": {"$gte": since}} if since else {}


def image_pipeline(since=None):
    """Per (model, provider) totals from the image ledger."""
    return [
        {"$match": _match(since)},
        {
            "$group": {
                "_id": {"model": "$model", "provider": IMAGE_PROVIDER},
                "calls": {"$sum": 1},
                "usd": {"$sum": IMAGE_EFFECTIVE_USD},
                "settled_usd": {"$sum": {"$cond": [HAS_RECONCILED, "$reconciled.costUSD", 0]}},
                "settled_list_usd": {
                    "$sum": {"$cond": [HAS_RECONCILED, {"$ifNull": ["$reconciled.directUSD", 0]}, 0]}
                },
                "settled_calls": {"$sum": {"$cond": [HAS_RECONCILED, 1, 0]}},
                "reported_calls": {
                    "$sum": {"$cond": [{"$and": [{"$not": HAS_RECONCILED}, HAS_REPORTED]}, 1, 0]}
                },
                "ambiguous": {"$sum": {"$cond": [{"$eq": ["$reconciled.ambiguous", True]}, 1, 0]}},
            }
        },
    ]


def audio_pipeline(since=None):
    """Per model totals from the audio ledger. Every row is OpenRouter-reported."""
    return [
        {"$match": _match(since)},
        {
            "$group": {
                "_id": {"model": "$model", "provider": "openrouter"},
                "calls": {"$sum": 1},
                "usd": {"$sum": AUDIO_EFFECTIVE_USD},
                "reported_calls": {"$sum": {"$cond": [HAS_REPORTED, 1, 0]}},
                "audio_tokens": {"$sum": {"$ifNull": ["$audioTokens", 0]}},
            }
        },
    ]


def fold_rows(image_groups, audio_groups):
    """Turn the two aggregations into one table, dearest first.

    Every row carries the three flags the transaction tables use, so the
    template can tag confidence the same way: `has_settled` (the marketplace's
    own charge), `has_reported` (the provider's own charge, in the response),
    `has_list` (neither yet — catalogue price, awaiting reconciliation).
    """
    rows = []
    for g in image_groups:
        calls = g["calls"]
        settled = g.get("settled_calls", 0)
        reported = g.get("reported_calls", 0)
        rows.append(
            {
                "tool": "imager",
                "model": g["_id"]["model"],
                "provider": g["_id"]["provider"],
                "calls": calls,
                "unit": "image",
                "usd": float(g["usd"]),
                "settled_usd": float(g.get("settled_usd", 0)),
                "settled_list_usd": float(g.get("settled_list_usd", 0)),
                "has_settled": settled > 0,
                "has_reported": reported > 0,
                "has_list": calls - settled - reported > 0,
                "list_calls": calls - settled - reported,
                "ambiguous": g.get("ambiguous", 0),
                "extra": "",
            }
        )
    for g in audio_groups:
        calls = g["calls"]
        reported = g.get("reported_calls", 0)
        tokens = g.get("audio_tokens", 0)
        rows.append(
            {
                "tool": "audio-ears",
                "model": g["_id"]["model"],
                "provider": "openrouter",
                "calls": calls,
                "unit": "listen",
                "usd": float(g["usd"]),
                "settled_usd": 0.0,
                "settled_list_usd": 0.0,
                "has_settled": False,
                "has_reported": reported > 0,
                "has_list": calls - reported > 0,
                "list_calls": calls - reported,
                "ambiguous": 0,
                "extra": f"{tokens:,} audio tokens" if tokens else "",
            }
        )
    for r in rows:
        r["saved"] = r["settled_list_usd"] - r["settled_usd"]
    return sorted(rows, key=lambda r: r["usd"], reverse=True)


def totals_from_rows(rows):
    usd = sum(r["usd"] for r in rows)
    return {
        "usd": usd,
        "calls": sum(r["calls"] for r in rows),
        "list_calls": sum(r["list_calls"] for r in rows),
        "settled_usd": sum(r["settled_usd"] for r in rows),
        "settled_list_usd": sum(r["settled_list_usd"] for r in rows),
        "ambiguous": sum(r["ambiguous"] for r in rows),
    }


def spend_since(db, since=None):
    """Dollars across both ledgers since `since` (all time when None)."""
    usd = 0.0
    for name, pipeline in (
        ("mcp_image_gen_usage", image_pipeline(since)),
        ("mcp_audio_ears_usage", audio_pipeline(since)),
    ):
        for g in db[name].aggregate(pipeline):
            usd += float(g["usd"])
    return usd


def table(db):
    rows = fold_rows(
        list(db["mcp_image_gen_usage"].aggregate(image_pipeline())),
        list(db["mcp_audio_ears_usage"].aggregate(audio_pipeline())),
    )
    return rows, totals_from_rows(rows)


def summary(db, now=None):
    """Everything the index route needs: per-period spend and the table."""
    now = now or datetime.now(timezone.utc)
    today = now.replace(hour=0, minute=0, second=0, microsecond=0)
    from datetime import timedelta

    rows, totals = table(db)
    return {
        "today": spend_since(db, today),
        "week": spend_since(db, now - timedelta(days=7)),
        "month": spend_since(db, now - timedelta(days=30)),
        "all": totals["usd"],
        "rows": rows,
        "totals": totals,
    }
