"""LibreChat cost dashboard + export sidecar — reads MongoDB directly.

Cost math:
    `tokenValue` is stored as negative micro-USD (1 unit = $0.000001).
    abs(tokenValue) / 1_000_000 = USD.

Export: walks `messages` per conversation, rebuilds the parent/child tree,
emits markdown or JSONL. Branchy conversations get one document per leaf.
"""

import io
import json
import os
import re
import zipfile
from datetime import datetime, timedelta, timezone

from flask import Flask, Response, abort, render_template_string, request
from pymongo import MongoClient

import buyer
import markets
import reconcile
import sidecars
from listprices import list_prices
from routing import IS_ESTIMATED

MICRO_PER_USD = 1_000_000
ROOT_PARENT = "00000000-0000-0000-0000-000000000000"

#: Marketplace credit below which the dashboard stops treating the balance as
#: background information and starts asking for a top-up. Around a dollar is a
#: few long Opus conversations at current discounts — enough warning to act on,
#: rare enough not to become wallpaper.
CREDIT_LOW_USD = 1.0

app = Flask(__name__)
app.register_blueprint(markets.bp)
app.register_blueprint(buyer.bp)
client = MongoClient(os.environ["MONGO_URI"])
db = client.get_default_database()
transactions = db["transactions"]
messages_col = db["messages"]
conversations_col = db["conversations"]


# A transaction carrying `routedVia` went somewhere other than the provider's own
# API. That alone does not make its price an estimate: OpenRouter reports exact
# per-request costs, which LibreChat fetches and bills from. `routing.py` decides
# from the destination host, so this file never has to know which is which.
#
# `reconcile.py` later settles the estimated ones against the gateway's own
# billing records and writes `reconciled.costUSD`. Three states therefore exist,
# and the tables below keep them apart so an estimate is never shown as verified:
#
#   exact       not estimated            — billed at a rate the destination reported
#   nominal     estimated, unreconciled  — from the model-name rate table
#   reconciled  estimated + reconciled   — the gateway's actual charge
#
# Tested against "missing" rather than truthiness because a settled cost of
# exactly 0 is legitimate: sub-micro-dollar requests round to nothing.
HAS_RECONCILED = {"$ne": [{"$type": "$reconciled.costUSD"}, "missing"]}

#: Best available cost per transaction, in micro-USD, preferring the settled figure.
EFFECTIVE_MICRO = {
    "$cond": [
        HAS_RECONCILED,
        {"$multiply": ["$reconciled.costUSD", MICRO_PER_USD]},
        {"$abs": "$tokenValue"},
    ]
}

NOMINAL_COST = {
    "$sum": {
        "$cond": [
            {"$and": [IS_ESTIMATED, {"$not": HAS_RECONCILED}]},
            {"$abs": "$tokenValue"},
            0,
        ]
    }
}

#: What the gateway actually charged, for rows that have been settled.
RECONCILED_COST = {"$sum": {"$cond": [HAS_RECONCILED, EFFECTIVE_MICRO, 0]}}

#: Provider list price for those same rows — the baseline the saving is measured against.
DIRECT_COST = {
    "$sum": {
        "$cond": [
            HAS_RECONCILED,
            {"$multiply": [{"$ifNull": ["$reconciled.directUSD", 0]}, MICRO_PER_USD]},
            0,
        ]
    }
}


def _cost_since(since):
    match = {"createdAt": {"$gte": since}} if since else {}
    pipeline = [
        {"$match": match},
        {"$group": {"_id": None, "micro": {"$sum": EFFECTIVE_MICRO}}},
    ]
    result = list(transactions.aggregate(pipeline))
    return (result[0]["micro"] / MICRO_PER_USD) if result else 0.0


def _nominal_since(since):
    match = {"createdAt": {"$gte": since}} if since else {}
    pipeline = [
        {"$match": {**match, "routedVia.baseURL": {"$exists": True}}},
        {"$match": {"$expr": IS_ESTIMATED}},
        {"$group": {"_id": None, "micro": NOMINAL_COST}},
    ]
    result = list(transactions.aggregate(pipeline))
    return (result[0]["micro"] / MICRO_PER_USD) if result else 0.0


def _savings():
    """Settled gateway spend against what the same traffic would have cost direct.

    This is the number that answers "is the marketplace actually saving me
    money" — and unlike the catalog discount it is measured on requests that
    really happened, at the prices really paid.
    """
    pipeline = [
        {"$match": {"reconciled.costUSD": {"$exists": True}}},
        {
            "$group": {
                "_id": None,
                "actual": RECONCILED_COST,
                "direct": DIRECT_COST,
                "requests": {"$sum": 1},
                "ambiguous": {
                    "$sum": {"$cond": [{"$eq": ["$reconciled.ambiguous", True]}, 1, 0]}
                },
            }
        },
    ]
    result = list(transactions.aggregate(pipeline))
    if not result:
        return {"actual": 0.0, "direct": 0.0, "saved": 0.0, "pct": 0.0,
                "requests": 0, "ambiguous": 0}
    row = result[0]
    actual = row["actual"] / MICRO_PER_USD
    direct = row["direct"] / MICRO_PER_USD
    return {
        "actual": actual,
        "direct": direct,
        "saved": direct - actual,
        "pct": ((direct - actual) / direct * 100) if direct > 0 else 0.0,
        "requests": row["requests"],
        "ambiguous": row["ambiguous"],
    }


# Anthropic prices a cache write at 1.25x and a cache read at 0.10x the model's
# own input rate, and every entry in LibreChat's `cacheTokenValues` follows those
# two ratios exactly. Surplus preserves them as well: a settled cache read came
# back 12.4x below the write that created it (2026-08-21, claude-opus-4.8), which
# is 1.25/0.10 to within rounding.
#
# That fixed shape is what makes the panel below possible without knowing any
# model's rate. A prompt transaction's stored cost is `rate x actual_units`,
# where `actual_units = input + 1.25*write + 0.10*read`. The same tokens with no
# caching would have cost `rate x (input + write + read)`. The rate cancels, so
# scaling the cost we already have by the ratio of those two sums gives the exact
# counterfactual — for nominal and settled rows alike, since both are
# proportional to the same unit count.
CACHE_WRITE_MULTIPLIER = 1.25
CACHE_READ_MULTIPLIER = 0.10

# Stored negative, exactly like `rawAmount` — a debit against the account. Every
# use below wants the magnitude, and a `$gt: 0` test against the raw field is
# silently always false, which reads as "caching never happened" on data where it
# plainly did.
_W = {"$abs": {"$ifNull": ["$writeTokens", 0]}}
_R = {"$abs": {"$ifNull": ["$readTokens", 0]}}
_I = {"$abs": {"$ifNull": ["$inputTokens", 0]}}

#: Billable units actually incurred, cache discounts applied.
ACTUAL_UNITS = {
    "$add": [
        _I,
        {"$multiply": [_W, CACHE_WRITE_MULTIPLIER]},
        {"$multiply": [_R, CACHE_READ_MULTIPLIER]},
    ]
}
#: The same tokens billed flat, as if no cache had been used.
UNCACHED_UNITS = {"$add": [_I, _W, _R]}

#: Only prompt transactions that actually went through the cache carry the
#: breakdown; everything else has no `writeTokens`/`readTokens` at all and must
#: be excluded, or its plain input would read as a 0% cache hit rate.
HAS_CACHE_TOKENS = {
    "$and": [
        {"$eq": ["$tokenType", "prompt"]},
        {"$gt": [{"$add": [_W, _R]}, 0]},
    ]
}

#: What those rows would have cost with caching off. Guarded against a zero unit
#: count, which cannot happen given the `$gt` above but would be a divide-by-zero
#: if a future schema change ever let it through.
UNCACHED_MICRO = {
    "$cond": [
        {"$gt": [ACTUAL_UNITS, 0]},
        {"$multiply": [EFFECTIVE_MICRO, {"$divide": [UNCACHED_UNITS, ACTUAL_UNITS]}]},
        EFFECTIVE_MICRO,
    ]
}


def _cache_stats():
    """Did prompt caching pay for itself, per destination?

    The question this exists to answer is not "is the cache working" but "is it
    earning the write premium". On a marketplace the seller is chosen per
    request, so a cache written on one turn is only read on the next if the same
    seller answers; a run of misses bills every prefix at 1.25x and saves
    nothing. That failure is silent — the requests all succeed — so it has to be
    read off the money, which is what `saved` below is.

    A negative `saved` means caching is costing more than it returns and should
    be turned off for that destination. Nothing else in the stack will say so.
    """
    return _fold_cache_rows(
        transactions.aggregate(
            [
                {"$match": {"$expr": HAS_CACHE_TOKENS}},
                {
                    "$group": {
                        "_id": {
                            "name": {"$ifNull": ["$routedVia.endpoint", "Direct to provider"]},
                            "model": "$model",
                        },
                        "write": {"$sum": _W},
                        "read": {"$sum": _R},
                        "plain": {"$sum": _I},
                        "actual": {"$sum": EFFECTIVE_MICRO},
                        "uncached": {"$sum": UNCACHED_MICRO},
                        "messages": {"$sum": 1},
                    }
                },
            ]
        )
    )


def _fold_cache_rows(rows):
    """Collapse per-(destination, model) groups into per-destination rows.

    Split out from the query so the arithmetic that decides whether caching is
    winning can be tested without a database.
    """
    by_dest = {}
    for r in rows:
        dest = by_dest.setdefault(
            r["_id"]["name"],
            {"name": r["_id"]["name"], "write": 0, "read": 0, "plain": 0,
             "actual": 0.0, "uncached": 0.0, "messages": 0, "models": []},
        )
        for field in ("write", "read", "plain", "messages"):
            dest[field] += r[field]
        dest["actual"] += r["actual"] / MICRO_PER_USD
        dest["uncached"] += r["uncached"] / MICRO_PER_USD
        dest["models"].append(r["_id"]["model"])

    out = []
    for dest in by_dest.values():
        through = dest["write"] + dest["read"]
        dest["hit_rate"] = (dest["read"] / through * 100) if through else 0.0
        dest["saved"] = dest["uncached"] - dest["actual"]
        dest["saved_pct"] = (
            (dest["saved"] / dest["uncached"] * 100) if dest["uncached"] > 0 else 0.0
        )
        # Token counts arrive as doubles — `$abs` preserves the type, and the
        # schema stores them alongside `rawAmount` rather than as counters. They
        # are counts, so round them back to whole tokens rather than rendering
        # "5,725,380.0".
        for field in ("write", "read", "plain"):
            dest[field] = round(dest[field])
        models = sorted(set(dest["models"]))
        dest["models_all"] = ", ".join(models)
        # A busy endpoint accumulates a dozen models and the cell stops being
        # readable. Three names say which family is doing the caching; the rest
        # stay available on hover.
        dest["models"] = (
            models
            if len(models) <= 3
            else models[:3] + [f"+{len(models) - 3} more"]
        )
        out.append(dest)
    out.sort(key=lambda d: d["uncached"], reverse=True)

    total_read = sum(d["read"] for d in out)
    total_write = sum(d["write"] for d in out)
    through = total_read + total_write
    return {
        "rows": out,
        "read": total_read,
        "write": total_write,
        "hit_rate": (total_read / through * 100) if through else 0.0,
        "saved": sum(d["saved"] for d in out),
        "actual": sum(d["actual"] for d in out),
        "uncached": sum(d["uncached"] for d in out),
        "messages": sum(d["messages"] for d in out),
    }


def _split_io(rows, key_fn, extras=None):
    """Collapse [(key, tokenType) -> tokens, cost] rows into per-key in/out totals."""
    out = {}
    for r in rows:
        key = key_fn(r["_id"])
        bucket = out.setdefault(
            key,
            {
                "in_tokens": 0,
                "out_tokens": 0,
                "in_cost": 0.0,
                "out_cost": 0.0,
                "messages": 0,
                "nominal_cost": 0.0,
                "settled_cost": 0.0,
                "direct_cost": 0.0,
            },
        )
        if r["_id"]["type"] == "prompt":
            bucket["in_tokens"] = r["tokens"]
            bucket["in_cost"] = r["cost"] / MICRO_PER_USD
        else:
            bucket["out_tokens"] = r["tokens"]
            bucket["out_cost"] = r["cost"] / MICRO_PER_USD
        bucket["messages"] += r["messages"]
        bucket["nominal_cost"] += r.get("nominal", 0) / MICRO_PER_USD
        bucket["settled_cost"] += r.get("settled", 0) / MICRO_PER_USD
        bucket["direct_cost"] += r.get("direct", 0) / MICRO_PER_USD
        if extras:
            bucket.update(extras(r))
    for bucket in out.values():
        bucket["total_cost"] = bucket["in_cost"] + bucket["out_cost"]
        bucket["has_nominal"] = bucket["nominal_cost"] > 0
        bucket["has_settled"] = bucket["settled_cost"] > 0
        bucket["saved"] = bucket["direct_cost"] - bucket["settled_cost"]
    return out


def _by_routing():
    """Spend split by where the request actually went."""
    rows = list(
        transactions.aggregate(
            [
                {
                    "$group": {
                        "_id": {
                            "name": "$routedVia.endpoint",
                            "url": "$routedVia.baseURL",
                            "type": "$tokenType",
                        },
                        "tokens": {"$sum": {"$abs": "$rawAmount"}},
                        "cost": {"$sum": EFFECTIVE_MICRO},
                        "messages": {"$sum": 1},
                        "nominal": NOMINAL_COST,
                        "settled": RECONCILED_COST,
                        "direct": DIRECT_COST,
                    }
                }
            ]
        )
    )

    def extras(r):
        url = r["_id"].get("url")
        return {
            "name": r["_id"].get("name") or ("Direct to provider" if not url else "(unnamed)"),
            "url": url or "provider default",
            "routed": bool(url),
        }

    grouped = _split_io(
        rows, key_fn=lambda k: (k.get("name"), k.get("url")), extras=extras
    )
    return sorted(grouped.values(), key=lambda r: r["total_cost"], reverse=True)


def _by_model():
    rows = list(
        transactions.aggregate(
            [
                {
                    "$group": {
                        "_id": {"model": "$model", "type": "$tokenType"},
                        "tokens": {"$sum": {"$abs": "$rawAmount"}},
                        "cost": {"$sum": EFFECTIVE_MICRO},
                        "messages": {"$sum": 1},
                        "nominal": NOMINAL_COST,
                        "settled": RECONCILED_COST,
                        "direct": DIRECT_COST,
                    }
                }
            ]
        )
    )
    grouped = _split_io(rows, key_fn=lambda k: k["model"])
    for model, b in grouped.items():
        b["model"] = model
    return sorted(grouped.values(), key=lambda m: m["total_cost"], reverse=True)


def _by_conversation():
    rows = list(
        transactions.aggregate(
            [
                {
                    "$group": {
                        "_id": {"cid": "$conversationId", "type": "$tokenType"},
                        "tokens": {"$sum": {"$abs": "$rawAmount"}},
                        "cost": {"$sum": EFFECTIVE_MICRO},
                        "messages": {"$sum": 1},
                        "nominal": NOMINAL_COST,
                        "settled": RECONCILED_COST,
                        "direct": DIRECT_COST,
                    }
                },
                {
                    "$lookup": {
                        "from": "conversations",
                        "localField": "_id.cid",
                        "foreignField": "conversationId",
                        "as": "c",
                    }
                },
            ]
        )
    )

    def extras(r):
        convo = r["c"][0] if r.get("c") else {}
        updated = convo.get("updatedAt")
        return {
            "cid": r["_id"]["cid"],
            "title": convo.get("title") or "—",
            "endpoint": convo.get("endpoint") or "?",
            "model": convo.get("model") or "?",
            "updated": updated.strftime("%Y-%m-%d %H:%M") if updated else "",
        }

    grouped = _split_io(rows, key_fn=lambda k: k["cid"], extras=extras)
    return sorted(grouped.values(), key=lambda c: c["total_cost"], reverse=True)


TEMPLATE = r"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>LibreChat cost</title>
<style>
@font-face{font-family:"Aleo";font-style:normal;font-weight:300 700;font-display:swap;src:url(/fonts/aleo-normal.woff2) format("woff2")}
@font-face{font-family:"Aleo";font-style:italic;font-weight:300 700;font-display:swap;src:url(/fonts/aleo-italic.woff2) format("woff2")}
</style>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
:root {
  --bg: #161616;
  --panel: #1f1f1f;
  --hover: #262626;
  --border: #2e2e2e;
  --text: #e0ddd6;
  --muted: #8b8680;
  --dim: #5a5651;
  --accent: #c9a87a;
}
* { box-sizing: border-box; }
body { font-family: "Aleo", Georgia, Charter, serif; background: var(--bg); color: var(--text);
       max-width: 1400px; margin: 1.5em auto; padding: 0 1.5em; line-height: 1.4; }
h1 { font-weight: 600; margin: 0 0 0.2em; font-size: 1.6em; }
h2 { font-weight: 600; margin: 2em 0 0.4em; padding-bottom: 0.3em; border-bottom: 1px solid var(--border);
     font-size: 1.2em; color: var(--accent); }
.subhead { color: var(--muted); font-size: 0.9em; }
.summary { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0.8em; margin: 1.5em 0; }
.summary.five { grid-template-columns: repeat(5, 1fr); }
/* Credit is money still to spend, not money spent — it reads down the same row
   as the totals, so it is tinted apart from them rather than sitting in a
   banner of its own while it is healthy. */
.card.credit { border-color: #3a3450; background: #1c1a24; }
.card.credit .label { color: #a99ce0; }
.card { background: var(--panel); border: 1px solid var(--border); border-radius: 5px; padding: 0.9em 1em; }
.card .label { color: var(--muted); font-size: 0.78em; text-transform: uppercase; letter-spacing: 0.06em; }
.card .value { font-size: 1.7em; margin-top: 0.25em; font-variant-numeric: tabular-nums; }
.card .value.small { font-size: 1.3em; }
table { border-collapse: collapse; width: 100%; margin-top: 0.4em; font-size: 0.95em; }
th, td { padding: 0.4em 0.7em; text-align: right; border-bottom: 1px solid var(--border); }
th { background: var(--panel); color: var(--muted); font-weight: 500; font-size: 0.78em;
     text-transform: uppercase; letter-spacing: 0.05em; }
th.left, td.left { text-align: left; }
tr:hover td { background: var(--hover); }
.num { font-variant-numeric: tabular-nums; }
.mono { font-family: "JetBrains Mono", ui-monospace, Menlo, monospace; font-size: 0.88em; }
.dim { color: var(--dim); }
.muted { color: var(--muted); }
.cost { color: var(--accent); font-weight: 500; }
.title-cell { max-width: 460px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.warn { background: #2b2118; border: 1px solid #6b4f2a; border-left: 4px solid #d08a3e;
        border-radius: 5px; padding: 0.9em 1.1em; margin: 1.5em 0; }
.warn .warn-title { color: #e0a75f; font-weight: 600; margin-bottom: 0.35em; }
.warn p { margin: 0.4em 0 0; color: var(--muted); font-size: 0.92em; }
.tag { display: inline-block; font-size: 0.72em; padding: 0.1em 0.45em; border-radius: 3px;
       border: 1px solid #6b4f2a; color: #e0a75f; margin-left: 0.4em; vertical-align: middle;
       font-family: "JetBrains Mono", ui-monospace, monospace; }
.tag.ok { border-color: #3a4a35; color: #8fae7d; }
.tag.settled { border-color: #2f4a5a; color: #7fb2cc; }
.nominal-cost { color: #e0a75f; font-weight: 500; }
.settled-cost { color: #7fb2cc; font-weight: 500; }
.note { background: #16211f; border: 1px solid #2c4a44; border-left: 4px solid #3e9d8a;
        border-radius: 5px; padding: 0.9em 1.1em; margin: 1.5em 0; }
.note .note-title { color: #6fc7b1; font-weight: 600; margin-bottom: 0.35em; }
.note p { margin: 0.4em 0 0; color: var(--muted); font-size: 0.92em; }
.saved { color: #6fc7b1; font-weight: 500; }
.lost { color: #d97a6c; font-weight: 500; }
.bar { display: inline-block; vertical-align: middle; width: 58px; height: 6px; border-radius: 3px;
       background: #2e2e2e; overflow: hidden; margin-right: 0.5em; }
/* Bar and figure are one reading, so they must not be allowed to wrap apart. */
td.hit { white-space: nowrap; }
td.dest { white-space: nowrap; }
.bar > span { display: block; height: 100%; background: #6fc7b1; }
.bar.low > span { background: #d08a3e; }
.balance { background: #1c1a24; border: 1px solid #3a3450; border-left: 4px solid #8878c4;
           border-radius: 5px; padding: 0.9em 1.1em; margin: 1.5em 0; }
.balance .balance-title { color: #a99ce0; font-weight: 600; margin-bottom: 0.35em; }
.balance p { margin: 0.4em 0 0; color: var(--muted); font-size: 0.92em; }
.balance.low { background: #2b1a18; border-color: #6b3a2a; border-left-color: #d97a6c; }
.balance.low .balance-title { color: #e08a7a; }
/* Collapsible banners: .warn and .note both carry .banner plus a unique id,
   split into a head (caret + title) and a body div; the one toggle handler
   in the script block drives every banner from that markup alone. */
.banner .banner-head { display: flex; align-items: baseline; gap: 0.5em; }
.banner-head .warn-title, .banner-head .note-title { margin-bottom: 0; }
.banner-toggle { appearance: none; background: none; border: 0; padding: 0; margin: 0;
                 cursor: pointer; color: inherit; font: inherit; line-height: inherit;
                 display: inline-flex; align-items: center; flex: none; }
.banner-toggle:focus-visible { outline: 1px solid var(--accent); border-radius: 2px; }
.banner-caret { display: inline-block; font-size: 0.8em; transition: transform 0.15s ease; }
.banner[data-collapsed] { padding: 0.55em 1.1em; }
.banner[data-collapsed] .banner-body { display: none; }
.banner[data-collapsed] .banner-caret { transform: rotate(-90deg); }
/* Sortable headers: the caret hint is its own fixed-width node so toggling
   direction never shifts the column. */
th.sortable { cursor: pointer; user-select: none; -webkit-user-select: none; white-space: nowrap; }
th.sortable:hover { color: var(--text); }
th.sorted { color: var(--accent); }
th .sort-hint { display: inline-block; margin-left: 0.45em; width: 0.9em;
                color: var(--dim); font-size: 0.9em; }
th.sorted .sort-hint { color: var(--accent); }
/* Per-table row filtering. */
.table-tools { display: flex; align-items: baseline; gap: 0.7em; margin: 0.5em 0 0.3em; }
.table-filter { background: var(--panel); color: var(--text); border: 1px solid var(--border);
                border-radius: 4px; padding: 0.3em 0.6em; font: inherit; font-size: 0.88em;
                min-width: 280px; }
.table-filter:focus { outline: none; border-color: var(--accent); }
.table-filter::placeholder { color: var(--dim); }
.filter-count { color: var(--dim); font-size: 0.78em;
                font-family: "JetBrains Mono", ui-monospace, monospace; }
tr[hidden] { display: none; }
footer { color: var(--dim); font-size: 0.78em; text-align: right; margin: 3em 0 1em;
         font-family: "JetBrains Mono", ui-monospace, monospace; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
</style>
</head>
<body>

<h1>LibreChat cost</h1>
<div class="subhead">Live from MongoDB <span class="mono">transactions</span>. Costs are USD; numbers reflect what LibreChat itself charged against each conversation using <span class="mono">rate × tokens</span> at message time. Rates come from the model-name table, except where a gateway's own billing records have since replaced them &mdash; see <em>By routing</em>. The cards also include what the tool sidecars spent on their own keys &mdash; see <em>Tool sidecars</em>.</div>

<div class="summary{% if account.configured %} five{% endif %}">
  <div class="card"><div class="label">Today</div><div class="value">${{ "%.4f"|format(totals.today) }}</div></div>
  <div class="card"><div class="label">Last 7 days</div><div class="value">${{ "%.4f"|format(totals.week) }}</div></div>
  <div class="card"><div class="label">Last 30 days</div><div class="value">${{ "%.4f"|format(totals.month) }}</div></div>
  <div class="card"><div class="label">All time</div><div class="value">${{ "%.4f"|format(totals.all) }}</div></div>
  {% if account.configured %}
  <div class="card credit" title="Marketplace credit remaining, from the gateway's own account records">
    <div class="label">Credit left</div><div class="value">${{ "%.4f"|format(account.creditBalance) }}</div>
  </div>
  {% endif %}
</div>

{% if totals.nominal > 0 %}
{# Collapsible: .banner + unique id, head/body split so the shared toggle in
   the script block can drive this and the savings note identically. #}
<div class="warn banner" id="banner-nominal">
  <div class="banner-head">
    <button type="button" class="banner-toggle" aria-expanded="true"
            aria-controls="banner-nominal-body" aria-label="Toggle nominal-spend details"
            title="Collapse or expand">
      <span class="banner-caret" aria-hidden="true">&#9662;</span>
    </button>
    <div class="warn-title">${{"%.4f"|format(totals.nominal)}} of the all-time total is nominal, not billed</div>
  </div>
  <div class="banner-body" id="banner-nominal-body">
    <p>That spend went through a gateway that does not report its own prices, so it was priced from
    the model-name rate table &mdash; i.e. <em>what the provider would have charged</em>, not what the
    gateway actually did. A gateway that re-routes to a different upstream, or prices differently,
    is invisible to that table.</p>
    <p>Treat these figures as a lower-confidence estimate. The destination is recorded on each
    transaction (<span class="mono">routedVia</span>), so real rates are reconciled once the
    gateway settles them.</p>
  </div>
</div>
{% endif %}
{% if account.configured and account.creditBalance < CREDIT_LOW_USD %}
{# Credit is the one figure here that can stop the instance working — it runs out
   mid-conversation and the marketplace answers 402. While it is healthy it says
   its piece as a card above and nothing more; only when it is nearly gone does it
   earn a banner, because only then is there anything to do about it. #}
<div class="balance low">
  <div class="balance-title">
    ${{ "%.4f"|format(account.creditBalance) }} of marketplace credit left &mdash; top up before it runs out
  </div>
  <p>At the last {{ "%.1f"|format(account.savingsPct) }}% discount that is roughly
  ${{ "%.2f"|format(account.creditBalance / (1 - account.savingsPct / 100)) if account.savingsPct < 100 else 0 }}
  of provider-list traffic. When it reaches zero the marketplace answers 402 and
  conversations on those endpoints stop mid-reply.</p>
</div>
{% endif %}

{% if savings.requests > 0 %}
<div class="note banner" id="banner-savings">
  <div class="banner-head">
    <button type="button" class="banner-toggle" aria-expanded="true"
            aria-controls="banner-savings-body" aria-label="Toggle savings details"
            title="Collapse or expand">
      <span class="banner-caret" aria-hidden="true">&#9662;</span>
    </button>
    {# Six decimals: the whole point of this panel is the gap between two numbers
       that four decimals would round to the same thing. #}
    <div class="note-title">${{"%.6f"|format(savings.actual)}} settled against ${{"%.6f"|format(savings.direct)}} at the marketplace's list reference &mdash; ${{"%.6f"|format(savings.saved)}} saved ({{"%.1f"|format(savings.pct)}}%)</div>
  </div>
  <div class="banner-body" id="banner-savings-body">
  <p>Measured on {{"{:,}".format(savings.requests)}} reconciled transactions, using the gateway's
  own billing records rather than any rate table. This is the number to judge the marketplace on:
  the catalog discount describes the cheapest listed offer, this describes what was really paid.</p>
  {# The denominator is the marketplace's `direct_cost_usd`, and it is the marketplace's
     claim about list price, not the provider's. Measured against tx.ts on 2026-08-21 it
     landed exactly on Anthropic's rate for every model but two, where it sat 20% high
     (claude-opus-4.8, claude-fable-5) — the same two the market popup footnotes. Left
     uncorrected on purpose: this figure is the gateway's own record, and overwriting it
     would stop it being an independent one. #}
  <p class="dim">The denominator is the marketplace's own idea of list. Spot-checked against
  this fork's rate table it was exact for most models and ~20% high for
  <span class="mono">claude-opus-4.8</span> and <span class="mono">claude-fable-5</span>, which
  flatters the percentage above by roughly that share of their traffic.</p>
  {% if savings.ambiguous > 0 %}
  <p>{{"{:,}".format(savings.ambiguous)}} of them matched more than one billing record within the
  time window and were settled against the nearest &mdash; identical requests, so the figures differ
  only by whatever seller prices moved in between.</p>
  {% endif %}
  {% if account.configured and account.requests > 0 %}
  {# The same question answered by an independent source. The marketplace counts
     every request the key ever made, LibreChat only its own, so these will not
     tally exactly — agreement to within a few percent is the signal that
     reconciliation is matching well, and a wide gap that it is not. #}
  <p>The marketplace's own records say ${{"%.6f"|format(account.spent)}} against
  ${{"%.6f"|format(account.directUSD)}} across {{"{:,}".format(account.requests)}} requests
  &mdash; <span class="saved">{{"%.1f"|format(account.savingsPct)}}% saved</span>. That covers
  every request this key has made, LibreChat's or not, so it is a cross-check rather than the
  same number twice.</p>
  {% endif %}
  <p class="dim">Last reconciliation: {{reconcile_status}}</p>
  </div>
</div>
{% endif %}
{% if cache.messages > 0 %}
<h2>Prompt caching</h2>
<div class="subhead">Whether the cache is earning its keep. A write costs 1.25&times; the model's input
rate and a read 0.10&times;, so caching only pays when writes get read back. On a marketplace the
seller is chosen per request, and a cache written on one turn is read on the next only if the same
seller answers &mdash; a run of misses bills every prefix at 1.25&times; and saves nothing, with no
error to show for it. <strong>Saved</strong> is that judgement in dollars: it compares what these
requests cost against what the identical tokens would have cost with caching off. If it goes
negative for a destination, caching is losing money there.</div>
<div class="table-tools">
  <input type="search" class="table-filter" data-table-target="table-cache" autocomplete="off"
         placeholder="Filter destinations&hellip;" aria-label="Filter prompt caching rows">
  <span class="filter-count" data-count-for="table-cache" aria-live="polite"></span>
</div>
<table id="table-cache" data-sortable>
<thead><tr>
  <th class="left">Destination</th>
  <th class="left">Models</th>
  <th>Messages</th>
  <th>Written</th>
  <th>Read</th>
  <th class="left">Hit rate</th>
  <th>Cost</th>
  <th>Uncached</th>
  <th>Saved</th>
</tr></thead>
<tbody>
{% for r in cache.rows %}
<tr>
  <td class="left dest">{{ r.name }}</td>
  <td class="left dim mono" style="font-size:0.78em" title="{{ r.models_all }}">{{ r.models|join(", ") }}</td>
  <td class="num">{{ "{:,}".format(r.messages) }}</td>
  <td class="num">{{ "{:,}".format(r.write) }}</td>
  <td class="num">{{ "{:,}".format(r.read) }}</td>
  <td class="left num hit">
    {# The bar turns amber under 50%: below that, reads no longer outweigh the
       premium paid on the writes by a comfortable margin. #}
    <span class="bar{% if r.hit_rate < 50 %} low{% endif %}"><span style="width:{{ "%.0f"|format(r.hit_rate) }}%"></span></span>{{ "%.0f"|format(r.hit_rate) }}%
  </td>
  <td class="num cost">${{ "%.6f"|format(r.actual) }}</td>
  <td class="num dim">${{ "%.6f"|format(r.uncached) }}</td>
  <td class="num {% if r.saved >= 0 %}saved{% else %}lost{% endif %}">
    {% if r.saved >= 0 %}${{ "%.6f"|format(r.saved) }}{% else %}&minus;${{ "%.6f"|format(-r.saved) }}{% endif %}
    <span class="dim">({{ "%.0f"|format(r.saved_pct) }}%)</span>
  </td>
</tr>
{% endfor %}
</tbody>
<tfoot><tr>
  <td class="left muted">All destinations</td>
  <td></td>
  <td class="num muted">{{ "{:,}".format(cache.messages) }}</td>
  <td class="num muted">{{ "{:,}".format(cache.write) }}</td>
  <td class="num muted">{{ "{:,}".format(cache.read) }}</td>
  <td class="left num muted hit">{{ "%.0f"|format(cache.hit_rate) }}%</td>
  <td class="num cost">${{ "%.6f"|format(cache.actual) }}</td>
  <td class="num dim">${{ "%.6f"|format(cache.uncached) }}</td>
  <td class="num {% if cache.saved >= 0 %}saved{% else %}lost{% endif %}">
    {% if cache.saved >= 0 %}${{ "%.6f"|format(cache.saved) }}{% else %}&minus;${{ "%.6f"|format(-cache.saved) }}{% endif %}
  </td>
</tr></tfoot>
</table>
<div class="subhead" style="margin-top:0.6em">Counts only the prompt transactions that carried a
cache breakdown &mdash; a request whose prefix never reached the gateway's 4096-token cache floor is
absent rather than counted as a miss. Slow chats are the case to watch: this fork sends a 5-minute
TTL by default, so leaving a conversation idle longer than that guarantees the next turn rewrites
the whole prefix at 1.25&times;. The cache pill in the chat header counts that window down and arms
an hour on click.</div>
{% endif %}

<h2>By routing</h2>
<div class="subhead">Where requests actually went. <span class="mono">Direct to provider</span> rows are priced against rates we control; gateway rows are either settled from the gateway's billing records or still nominal.</div>
<div class="table-tools">
  <input type="search" class="table-filter" data-table-target="table-routing" autocomplete="off"
         placeholder="Filter destinations&hellip;" aria-label="Filter routing rows">
  <span class="filter-count" data-count-for="table-routing" aria-live="polite"></span>
</div>
<table id="table-routing" data-sortable>
<thead><tr>
  <th class="left">Destination</th>
  <th class="left">Base URL</th>
  <th>Messages</th>
  <th>Input tokens</th>
  <th>Output tokens</th>
  <th>Total $</th>
  <th>Saved vs direct</th>
  <th class="left">Confidence</th>
</tr></thead>
<tbody>
{% for r in by_routing %}
<tr>
  <td class="left">{{ r.name }}</td>
  <td class="left mono dim">{{ r.url }}</td>
  <td class="num">{{ "{:,}".format(r.messages) }}</td>
  <td class="num">{{ "{:,}".format(r.in_tokens) }}</td>
  <td class="num">{{ "{:,}".format(r.out_tokens) }}</td>
  <td class="num {% if r.has_nominal %}nominal-cost{% elif r.has_settled %}settled-cost{% else %}cost{% endif %}">${{ "%.4f"|format(r.total_cost) }}</td>
  <td class="num {% if r.has_settled %}saved{% else %}dim{% endif %}">{% if r.has_settled %}${{ "%.6f"|format(r.saved) }}{% else %}&mdash;{% endif %}</td>
  <td class="left">
    {% if not r.routed %}<span class="tag ok">billed rate</span>{% endif %}
    {% if r.has_settled %}<span class="tag settled">settled</span>{% endif %}
    {% if r.has_nominal %}<span class="tag">nominal</span>{% endif %}
  </td>
</tr>
{% endfor %}
</tbody>
</table>

<h2>By model</h2>
<div class="table-tools">
  <input type="search" class="table-filter" data-table-target="table-model" autocomplete="off"
         placeholder="Filter models&hellip;" aria-label="Filter model rows">
  <span class="filter-count" data-count-for="table-model" aria-live="polite"></span>
</div>
<table id="table-model" data-sortable>
<thead><tr>
  <th class="left">Model</th>
  <th>Messages</th>
  <th>Input tokens</th>
  <th>Output tokens</th>
  <th>Input $</th>
  <th>Output $</th>
  <th>Total $</th>
</tr></thead>
<tbody>
{% for m in by_model %}
<tr>
  <td class="left mono">{{ m.model }}{% if m.has_nominal %}<span class="tag" title="${{ "%.4f"|format(m.nominal_cost) }} of this was routed through a custom base URL and is priced nominally">~${{ "%.4f"|format(m.nominal_cost) }} nominal</span>{% endif %}</td>
  <td class="num">{{ "{:,}".format(m.messages) }}</td>
  <td class="num">{{ "{:,}".format(m.in_tokens) }}</td>
  <td class="num">{{ "{:,}".format(m.out_tokens) }}</td>
  <td class="num dim">${{ "%.4f"|format(m.in_cost) }}</td>
  <td class="num dim">${{ "%.4f"|format(m.out_cost) }}</td>
  <td class="num cost">${{ "%.4f"|format(m.total_cost) }}</td>
</tr>
{% endfor %}
</tbody>
</table>

{% if tools.rows %}
<h2>Tool sidecars</h2>
{# These ledgers are the sidecars' own — one row per image or listen, on a
   server-wide key, never a transaction. Their spend is in the cards above and
   nowhere else on this page: no conversation, no routing row, no model row.
   Confidence follows how each row was priced: `reported` is the provider's own
   figure in the response (OpenRouter), `settled` the marketplace's charge from
   its hourly export (Surplus, via reconcile.py), `list` the catalogue price of
   a Surplus call the export has not been matched to yet — about 3x what it will
   settle at, so a `list` figure is an over-estimate, never an under-estimate. #}
<div class="subhead">Spend by the MCP sidecars on their own server-wide keys &mdash; ${{ "%.4f"|format(tools.all) }} of the all-time total above, none of it attributable to a conversation. <span class="mono">imager</span> rows are one image each; <span class="mono">audio-ears</span> rows one listen.{% if tools.totals.list_calls > 0 %} {{ tools.totals.list_calls }} call{% if tools.totals.list_calls != 1 %}s{% endif %} still at catalogue list price, awaiting the marketplace's hourly export.{% endif %}</div>
<table id="table-tools" data-sortable>
<thead><tr>
  <th class="left">Tool</th>
  <th class="left">Model</th>
  <th class="left">Via</th>
  <th>Calls</th>
  <th>Total $</th>
  <th>Saved vs list</th>
  <th class="left">Confidence</th>
</tr></thead>
<tbody>
{% for r in tools.rows %}
<tr>
  <td class="left mono">{{ r.tool }}</td>
  <td class="left mono">{{ r.model }}{% if r.extra %} <span class="dim">({{ r.extra }})</span>{% endif %}</td>
  <td class="left dim">{{ "Surplus" if r.provider == "surplus" else "OpenRouter" }}</td>
  <td class="num">{{ "{:,}".format(r.calls) }}</td>
  <td class="num {% if r.has_list %}nominal-cost{% elif r.has_settled %}settled-cost{% else %}cost{% endif %}">${{ "%.4f"|format(r.usd) }}</td>
  <td class="num {% if r.has_settled %}saved{% else %}dim{% endif %}">{% if r.has_settled %}${{ "%.6f"|format(r.saved) }}{% else %}&mdash;{% endif %}</td>
  <td class="left">
    {% if r.has_reported %}<span class="tag ok">reported</span>{% endif %}
    {% if r.has_settled %}<span class="tag settled">settled{% if r.ambiguous %} ({{ r.ambiguous }} ambiguous){% endif %}</span>{% endif %}
    {% if r.has_list %}<span class="tag" title="{{ r.list_calls }} call(s) priced at the catalogue list rate until the marketplace's export is matched">list &times;{{ r.list_calls }}</span>{% endif %}
  </td>
</tr>
{% endfor %}
</tbody>
<tfoot><tr>
  <td class="left" colspan="3">Total</td>
  <td class="num">{{ "{:,}".format(tools.totals.calls) }}</td>
  <td class="num cost">${{ "%.4f"|format(tools.all) }}</td>
  <td class="num {% if tools.totals.settled_usd > 0 %}saved{% else %}dim{% endif %}">{% if tools.totals.settled_usd > 0 %}${{ "%.6f"|format(tools.totals.settled_list_usd - tools.totals.settled_usd) }}{% else %}&mdash;{% endif %}</td>
  <td></td>
</tr></tfoot>
</table>
{% endif %}

<h2>By conversation</h2>
<div class="subhead">Sorted by total cost. Endpoint and model shown reflect the conversation's last-used pairing.</div>
<div class="table-tools">
  <input type="search" class="table-filter" data-table-target="table-conv" autocomplete="off"
         placeholder="Filter conversations&hellip;" aria-label="Filter conversation rows">
  <span class="filter-count" data-count-for="table-conv" aria-live="polite"></span>
</div>
<table id="table-conv" data-sortable>
<thead><tr>
  <th class="left">Title</th>
  <th class="left">Endpoint</th>
  <th class="left">Model</th>
  <th>Input tokens</th>
  <th>Output tokens</th>
  <th>Input $</th>
  <th>Output $</th>
  <th>Total $</th>
  <th class="left">Last activity</th>
</tr></thead>
<tbody>
{% for c in by_conv %}
<tr>
  <td class="left title-cell" title="{{ c.title }}">{{ c.title }}{% if c.has_nominal %}<span class="tag" title="${{ "%.4f"|format(c.nominal_cost) }} routed through a custom base URL; priced nominally">nominal</span>{% endif %}</td>
  <td class="left muted">{{ c.endpoint }}</td>
  <td class="left mono">{{ c.model }}</td>
  <td class="num">{{ "{:,}".format(c.in_tokens) }}</td>
  <td class="num">{{ "{:,}".format(c.out_tokens) }}</td>
  <td class="num dim">${{ "%.4f"|format(c.in_cost) }}</td>
  <td class="num dim">${{ "%.4f"|format(c.out_cost) }}</td>
  <td class="num cost">${{ "%.4f"|format(c.total_cost) }}</td>
  <td class="left dim mono">{{ c.updated }}</td>
</tr>
{% endfor %}
</tbody>
</table>

<footer>Rendered {{ now }} · {{ tx_count }} transactions across {{ by_conv|length }} conversations{% if tools.totals.calls %} · {{ tools.totals.calls }} sidecar calls{% endif %}</footer>

<script>
(function () {
  "use strict";

  /* ── Collapsible banners ────────────────────────────────────────────────
     One mechanism for .warn and .note alike: each carries a unique id and a
     head/body split, and visibility is driven purely by the banner's
     data-collapsed attribute. Collapse state is remembered per banner id. */

  function setCollapsed(banner, toggle, collapsed) {
    if (collapsed) banner.setAttribute("data-collapsed", "");
    else banner.removeAttribute("data-collapsed");
    toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
  }

  function initBanner(banner) {
    var toggle = banner.querySelector(".banner-toggle");
    if (!toggle || banner.dataset.collapsible) return;
    banner.dataset.collapsible = "1";
    var key = "costdash:banner:" + banner.id;
    try {
      if (localStorage.getItem(key) === "1") setCollapsed(banner, toggle, true);
    } catch (e) { /* storage unavailable: state just won't persist */ }
    toggle.addEventListener("click", function () {
      var collapsed = !banner.hasAttribute("data-collapsed");
      setCollapsed(banner, toggle, collapsed);
      try { localStorage.setItem(key, collapsed ? "1" : "0"); } catch (e) {}
    });
  }

  /* ── Column sorting ─────────────────────────────────────────────────────
     Type-sensitive per cell: datetime (YYYY-MM-DD HH:MM…), number (strips
     $ , % and spaces; U+2212 is a real minus; a "(12%)" tail is ignored —
     only the leading figure counts) or text. Cells are classified
     individually, so a mixed column groups by type and "—" placeholders
     never interleave with the numbers. Only the body is reordered, so tfoot
     totals stay put and hidden (filtered) rows stay hidden. */

  function parseNumber(text) {
    if (!text || text === "\u2014" || text === "\u2013") return NaN;
    var m = text.replace(/\u2212/g, "-")
                .replace(/[$,%\u00a0\u2009\s,]/g, "")
                .match(/^-?\d*\.?\d+(?:e[+-]?\d+)?/i);
    return m ? parseFloat(m[0]) : NaN;
  }

  function parseDate(text) {
    var m = text.match(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/);
    if (!m) return NaN;
    return new Date(m[0].replace(" ", "T") + ":00Z").getTime();
  }

  function cellKey(cell) {
    var text = (cell.textContent || "").trim();
    var d = parseDate(text);
    if (!isNaN(d)) return { t: "d", v: d };
    var n = parseNumber(text);
    if (!isNaN(n)) return { t: "n", v: n };
    return { t: "s", v: text.toLowerCase() };
  }

  var TYPE_RANK = { n: 0, d: 1, s: 2 };

  function compareKeys(a, b, dir) {
    if (a.t !== b.t) return (TYPE_RANK[a.t] - TYPE_RANK[b.t]) * dir;
    if (a.v < b.v) return -dir;
    if (a.v > b.v) return dir;
    return 0;
  }

  function sortTable(table, colIndex, dir) {
    var body = table.tBodies[0];
    var keyed = Array.prototype.map.call(body.rows, function (row) {
      var cell = row.cells[colIndex];
      return { row: row, key: cell ? cellKey(cell) : { t: "s", v: "" } };
    });
    keyed.sort(function (a, b) { return compareKeys(a.key, b.key, dir); });
    keyed.forEach(function (k) { body.appendChild(k.row); });
  }

  function initTable(table) {
    var head = table.tHead, body = table.tBodies[0];
    if (!head || !body || !head.rows.length || table.dataset.sortableInit) return;
    table.dataset.sortableInit = "1";
    var ths = Array.prototype.slice.call(head.rows[0].cells);

    ths.forEach(function (th, i) {
      th.classList.add("sortable");
      th.setAttribute("data-col", String(i));
      th.setAttribute("aria-sort", "none");
      th.setAttribute("title", "Click to sort");
      var hint = document.createElement("span");
      hint.className = "sort-hint";
      hint.setAttribute("aria-hidden", "true");
      hint.textContent = "\u2195";
      var label = document.createElement("span");
      label.className = "th-label";
      while (th.firstChild) label.appendChild(th.firstChild);
      th.appendChild(label);
      th.appendChild(hint);
    });

    function setHints(activeCol, dir) {
      ths.forEach(function (th, i) {
        var active = i === activeCol;
        th.classList.toggle("sorted", active);
        th.setAttribute("aria-sort",
          active ? (dir === 1 ? "ascending" : "descending") : "none");
        th.querySelector(".sort-hint").textContent =
          active ? (dir === 1 ? "\u25b2" : "\u25bc") : "\u2195";
      });
    }

    head.addEventListener("click", function (ev) {
      var th = ev.target.closest ? ev.target.closest("th") : null;
      if (!th || ths.indexOf(th) === -1) return;
      var col = parseInt(th.getAttribute("data-col"), 10);
      var dir;
      var lastCol = table.dataset.sortCol === undefined
        ? -2 : parseInt(table.dataset.sortCol, 10);
      if (lastCol !== col) {
        table.dataset.sortCol = String(col);
        /* Numbers and dates read best biggest/newest first; text reads best
           A-first — so the first click on a new column picks by its type. */
        var sample = body.rows[0] ? cellKey(body.rows[0].cells[col]) : { t: "s" };
        dir = sample.t === "s" ? 1 : -1;
      } else {
        dir = -parseInt(table.dataset.sortDir || "1", 10);
      }
      table.dataset.sortDir = String(dir);
      sortTable(table, col, dir);
      setHints(col, dir);
    });
  }

  /* ── Row filtering ──────────────────────────────────────────────────────
     Space-separated terms, all of which must appear somewhere in the row
     (AND), so "surplus opus" narrows like a search box rather than needing
     regex. The count node reports visible-of-total while a query is active. */

  function applyFilter(table, query, count) {
    var terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    var shown = 0;
    Array.prototype.forEach.call(table.tBodies[0].rows, function (row) {
      var hay = row.textContent.toLowerCase();
      var hit = terms.every(function (t) { return hay.indexOf(t) !== -1; });
      row.hidden = terms.length > 0 && !hit;
      if (!row.hidden) shown++;
    });
    if (count) {
      count.textContent = terms.length
        ? shown + " of " + table.tBodies[0].rows.length + " rows"
        : "";
    }
  }

  function initFilters() {
    Array.prototype.forEach.call(
      document.querySelectorAll(".table-filter"),
      function (input) {
        var table = document.getElementById(input.getAttribute("data-table-target"));
        if (!table || input.dataset.filterInit) return;
        input.dataset.filterInit = "1";
        var count = document.querySelector(
          '[data-count-for="' + input.getAttribute("data-table-target") + '"]');
        input.addEventListener("input", function () {
          applyFilter(table, input.value, count);
        });
      }
    );
  }

  Array.prototype.forEach.call(document.querySelectorAll(".banner"), initBanner);
  Array.prototype.forEach.call(
    document.querySelectorAll("table[data-sortable]"), initTable);
  initFilters();
})();
</script>

</body>
</html>
"""


@app.route("/cost")
@app.route("/cost/")
def index():
    now = datetime.now(timezone.utc)
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    # The tool sidecars' ledgers are folded into the cards, because a card that
    # reads $0 on a day of image generation is a wrong number, not a partial one.
    # The three tables below still sum to the transactions alone; the sidecar
    # panel says how much of each card is its own.
    tools = sidecars.summary(db, now)
    totals = {
        "today": _cost_since(today_start) + tools["today"],
        "week": _cost_since(now - timedelta(days=7)) + tools["week"],
        "month": _cost_since(now - timedelta(days=30)) + tools["month"],
        "all": _cost_since(None) + tools["all"],
        "nominal": _nominal_since(None),
        "tools": tools,
    }
    return render_template_string(
        TEMPLATE,
        totals=totals,
        tools=tools,
        savings=_savings(),
        cache=_cache_stats(),
        account=buyer.summary(),
        CREDIT_LOW_USD=CREDIT_LOW_USD,
        reconcile_status=_reconcile_status(),
        by_model=_by_model(),
        by_conv=_by_conversation(),
        by_routing=_by_routing(),
        now=now.strftime("%Y-%m-%d %H:%M:%S UTC"),
        tx_count=transactions.estimated_document_count(),
    )


def _reconcile_status():
    """One-line summary of the background reconciler, for the savings panel."""
    state = reconcile.last_run()
    when = state.get("at")
    stamp = when.strftime("%Y-%m-%d %H:%M UTC") if hasattr(when, "strftime") else "never"
    if state.get("ok"):
        line = (
            f"{stamp} — matched {state.get('matched', 0)} of "
            f"{state.get('pending_groups', 0)} pending against "
            f"{state.get('export_rows', 0)} billing records"
        )
        images = state.get("images_matched", 0) + state.get("images_unmatched", 0)
        if images:
            line += f"; {state.get('images_matched', 0)} of {images} sidecar images"
        return line
    return f"{stamp} — {state.get('error') or state.get('note') or 'not run yet'}"


@app.route("/cost/reconcile", methods=["POST"])
def reconcile_now():
    """Manual trigger, so a settle can be forced without waiting for the timer."""
    return reconcile.run_once(transactions)


@app.route("/cost/healthz")
def healthz():
    """`rates` is the count of provider list prices read from the bind-mounted
    tx.ts. Zero means the mount is missing, and the market popup has quietly
    fallen back to measuring its discount against the marketplace's own
    marked-up reference — a wrong number with no error attached, so the deploy
    script checks this field."""
    return {
        "ok": True,
        "tx": transactions.estimated_document_count(),
        "rates": len(list_prices()),
    }


# ────────────────────────────────────────────────────────────────────────────
# Export
# ────────────────────────────────────────────────────────────────────────────

_SAFE = re.compile(r"[^A-Za-z0-9._-]+")


def _safe_filename(s, max_len=80):
    cleaned = _SAFE.sub("_", (s or "untitled").strip()).strip("_")
    return (cleaned or "untitled")[:max_len]


def _load_conversation(conv_id):
    return conversations_col.find_one({"conversationId": conv_id})


def _load_messages(conv_id):
    return list(messages_col.find({"conversationId": conv_id}).sort("createdAt", 1))


def _branches(msgs):
    """Return list of branches; each branch is a list of msgs root→leaf."""
    by_id = {m["messageId"]: m for m in msgs}
    children = {}
    for m in msgs:
        children.setdefault(m.get("parentMessageId"), []).append(m["messageId"])
    leaves = [m["messageId"] for m in msgs if m["messageId"] not in children]
    if not leaves:
        leaves = [m["messageId"] for m in msgs[-1:]]

    paths = []
    for leaf in leaves:
        path = []
        cur = leaf
        seen = set()
        while cur and cur != ROOT_PARENT and cur in by_id and cur not in seen:
            seen.add(cur)
            path.append(by_id[cur])
            cur = by_id[cur].get("parentMessageId")
        path.reverse()
        if path:
            paths.append(path)
    paths.sort(key=lambda p: (len(p), p[-1].get("createdAt") or datetime.min), reverse=True)
    return paths


def _fmt_ts(dt):
    if not dt:
        return ""
    if isinstance(dt, str):
        return dt
    return dt.strftime("%Y-%m-%d %H:%M:%S UTC")


def _msg_heading(m):
    role = "User" if m.get("isCreatedByUser") else (m.get("sender") or "Assistant")
    model = m.get("model")
    tok = m.get("tokenCount")
    ts = _fmt_ts(m.get("createdAt"))
    bits = [role]
    if model and not m.get("isCreatedByUser"):
        bits.append(f"— `{model}`")
    meta = []
    if ts:
        meta.append(ts)
    if tok:
        meta.append(f"{tok} tok")
    if meta:
        bits.append(f"_({', '.join(meta)})_")
    return "### " + " ".join(bits)


def _msg_body(m):
    """Extract text body. Newer LibreChat stores assistant output in `content[]`
    (Anthropic-style multi-part); legacy/user messages use `text`."""
    txt = (m.get("text") or "").strip()
    if txt:
        return txt
    parts = m.get("content") or []
    out = []
    for p in parts:
        if not isinstance(p, dict):
            continue
        t = p.get("type")
        if t == "text":
            out.append((p.get("text") or "").rstrip())
        elif t in ("tool_use", "tool_call"):
            name = p.get("name") or p.get("tool") or "tool"
            payload = p.get("input") or p.get("arguments") or {}
            out.append(f"```tool_use {name}\n{json.dumps(payload, indent=2, default=str)}\n```")
        elif t in ("tool_result", "tool_response"):
            payload = p.get("content") or p.get("output") or p
            out.append(f"```tool_result\n{json.dumps(payload, indent=2, default=str)}\n```")
        elif t == "thinking" or t == "reasoning":
            out.append(f"```thinking\n{(p.get('thinking') or p.get('text') or '').rstrip()}\n```")
        else:
            out.append(f"```{t or 'part'}\n{json.dumps(p, indent=2, default=str)}\n```")
    return "\n\n".join(filter(None, out))


def _render_markdown(conv, branches):
    title = (conv or {}).get("title") or "Untitled"
    endpoint = (conv or {}).get("endpoint") or "?"
    cid = (conv or {}).get("conversationId", "")
    out = [f"# {title}", "", f"- Conversation: `{cid}`", f"- Endpoint: `{endpoint}`",
           f"- Branches: {len(branches)}", f"- Exported: {_fmt_ts(datetime.now(timezone.utc))}", ""]
    multi = len(branches) > 1
    for i, branch in enumerate(branches, 1):
        if multi:
            out.append(f"\n---\n\n## Branch {i} of {len(branches)} ({len(branch)} messages)\n")
        for m in branch:
            out.append(_msg_heading(m))
            out.append("")
            out.append(_msg_body(m))
            out.append("")
    return "\n".join(out) + "\n"


def _messages_jsonl(msgs):
    buf = io.StringIO()
    for m in msgs:
        m = dict(m)
        m.pop("_id", None)
        for k in ("createdAt", "updatedAt", "expiredAt"):
            v = m.get(k)
            if hasattr(v, "isoformat"):
                m[k] = v.isoformat()
        buf.write(json.dumps(m, default=str, ensure_ascii=False))
        buf.write("\n")
    return buf.getvalue()


def _branch_files(conv, branches):
    """Yield (filename, content) tuples — one markdown file per branch."""
    title = _safe_filename((conv or {}).get("title") or "untitled")
    if len(branches) == 1:
        yield f"{title}.md", _render_markdown(conv, branches)
        return
    for i, branch in enumerate(branches, 1):
        leaf = branch[-1]
        model = _safe_filename(leaf.get("model") or "unknown")
        yield f"{title}__branch{i:02d}_{model}.md", _render_markdown(conv, [branch])


def _all_conversations():
    return list(
        conversations_col.find(
            {}, {"conversationId": 1, "title": 1, "endpoint": 1, "model": 1, "updatedAt": 1, "_id": 0}
        ).sort("updatedAt", -1)
    )


def _conv_msg_counts():
    rows = messages_col.aggregate(
        [{"$group": {"_id": "$conversationId", "n": {"$sum": 1}}}]
    )
    return {r["_id"]: r["n"] for r in rows}


EXPORT_TEMPLATE = """<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><title>LibreChat export</title>
<style>
@font-face{font-family:"Aleo";font-style:normal;font-weight:300 700;font-display:swap;src:url(/fonts/aleo-normal.woff2) format("woff2")}
@font-face{font-family:"Aleo";font-style:italic;font-weight:300 700;font-display:swap;src:url(/fonts/aleo-italic.woff2) format("woff2")}
</style>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
:root { --bg:#161616; --panel:#1f1f1f; --hover:#262626; --border:#2e2e2e;
        --text:#e0ddd6; --muted:#8b8680; --dim:#5a5651; --accent:#c9a87a; }
* { box-sizing: border-box; }
body { font-family:"Aleo",Georgia,Charter,serif; background:var(--bg); color:var(--text);
       max-width:1400px; margin:1.5em auto; padding:0 1.5em; line-height:1.4; }
h1 { font-weight:600; margin:0 0 .2em; font-size:1.6em; }
h2 { font-weight:600; margin:2em 0 .4em; padding-bottom:.3em; border-bottom:1px solid var(--border);
     font-size:1.2em; color:var(--accent); }
.subhead { color:var(--muted); font-size:.9em; }
.bulk { background:var(--panel); border:1px solid var(--border); border-radius:5px;
        padding:.9em 1.1em; margin:1em 0 1.5em; display:flex; gap:.8em; flex-wrap:wrap; align-items:center; }
.bulk strong { color:var(--accent); margin-right:.5em; }
table { border-collapse:collapse; width:100%; margin-top:.4em; font-size:.95em; }
th, td { padding:.4em .7em; text-align:left; border-bottom:1px solid var(--border); }
th { background:var(--panel); color:var(--muted); font-weight:500; font-size:.78em;
     text-transform:uppercase; letter-spacing:.05em; }
td.num, th.num { text-align:right; font-variant-numeric:tabular-nums; }
tr:hover td { background:var(--hover); }
.mono { font-family:"JetBrains Mono",ui-monospace,Menlo,monospace; font-size:.85em; }
.dim { color:var(--dim); } .muted { color:var(--muted); }
.title-cell { max-width:520px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.btn { color:var(--accent); text-decoration:none; padding:.15em .55em; border:1px solid var(--border);
       border-radius:3px; font-size:.82em; font-family:"JetBrains Mono",ui-monospace,monospace; }
.btn:hover { background:var(--hover); }
.branchy { color:var(--accent); font-weight:500; }
footer { color:var(--dim); font-size:.78em; text-align:right; margin:3em 0 1em;
         font-family:"JetBrains Mono",ui-monospace,monospace; }
</style>
</head><body>

<h1>LibreChat export</h1>
<div class="subhead">Direct from MongoDB. Branchy conversations are exported as one markdown file per leaf so you can diff model responses to the same prefix.</div>

<div class="bulk">
  <strong>Bulk:</strong>
  <a class="btn" href="/export/all.md.zip">All conversations · Markdown ZIP</a>
  <a class="btn" href="/export/all.jsonl.zip">All conversations · JSONL ZIP</a>
  <a class="btn" href="/export/all.branches.zip">All branches split · Markdown ZIP</a>
</div>

<h2>Conversations ({{ convs|length }})</h2>
<table>
<thead><tr>
  <th>Title</th>
  <th>Endpoint</th>
  <th>Model</th>
  <th>Branches</th>
  <th class="num">Msgs</th>
  <th>Updated</th>
  <th>Download</th>
</tr></thead>
<tbody>
{% for c in convs %}
<tr>
  <td class="title-cell" title="{{ c.title }}">{{ c.title or '—' }}</td>
  <td class="muted">{{ c.endpoint or '?' }}</td>
  <td class="mono">{{ c.model or '?' }}</td>
  <td class="{% if c.branches > 1 %}branchy{% else %}dim{% endif %}">{{ c.branches }}</td>
  <td class="num">{{ c.n }}</td>
  <td class="dim mono">{{ c.updated }}</td>
  <td>
    <a class="btn" href="/export/{{ c.cid }}.md">md</a>
    <a class="btn" href="/export/{{ c.cid }}.jsonl">jsonl</a>
    {% if c.branches > 1 %}<a class="btn" href="/export/{{ c.cid }}.zip">zip</a>{% endif %}
  </td>
</tr>
{% endfor %}
</tbody>
</table>

<footer>Rendered {{ now }} · {{ convs|length }} conversations</footer>

</body></html>
"""


@app.route("/export")
@app.route("/export/")
def export_index():
    convs = _all_conversations()
    counts = _conv_msg_counts()
    rows = []
    for c in convs:
        cid = c["conversationId"]
        if counts.get(cid, 0) == 0:
            continue
        msgs = _load_messages(cid)
        branches = _branches(msgs)
        rows.append({
            "cid": cid,
            "title": c.get("title") or "—",
            "endpoint": c.get("endpoint") or "?",
            "model": c.get("model") or "?",
            "n": len(msgs),
            "branches": len(branches),
            "updated": c["updatedAt"].strftime("%Y-%m-%d %H:%M") if c.get("updatedAt") else "",
        })
    return render_template_string(
        EXPORT_TEMPLATE,
        convs=rows,
        now=datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC"),
    )


@app.route("/export/<conv_id>.md")
def export_md(conv_id):
    conv = _load_conversation(conv_id)
    msgs = _load_messages(conv_id)
    if not msgs:
        abort(404)
    body = _render_markdown(conv, _branches(msgs))
    fname = _safe_filename((conv or {}).get("title") or conv_id) + ".md"
    return Response(body, mimetype="text/markdown; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="{fname}"'})


@app.route("/export/<conv_id>.jsonl")
def export_jsonl(conv_id):
    msgs = _load_messages(conv_id)
    if not msgs:
        abort(404)
    body = _messages_jsonl(msgs)
    conv = _load_conversation(conv_id)
    fname = _safe_filename((conv or {}).get("title") or conv_id) + ".jsonl"
    return Response(body, mimetype="application/jsonl; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="{fname}"'})


@app.route("/export/<conv_id>.zip")
def export_branches_zip(conv_id):
    conv = _load_conversation(conv_id)
    msgs = _load_messages(conv_id)
    if not msgs:
        abort(404)
    branches = _branches(msgs)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for fname, content in _branch_files(conv, branches):
            zf.writestr(fname, content)
        zf.writestr("_all_messages.jsonl", _messages_jsonl(msgs))
    buf.seek(0)
    zip_name = _safe_filename((conv or {}).get("title") or conv_id) + "__branches.zip"
    return Response(buf.read(), mimetype="application/zip",
                    headers={"Content-Disposition": f'attachment; filename="{zip_name}"'})


@app.route("/export/all.<fmt>.zip")
def export_all(fmt):
    if fmt not in {"md", "jsonl", "branches"}:
        abort(404)
    convs = _all_conversations()
    counts = _conv_msg_counts()
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for c in convs:
            cid = c["conversationId"]
            if counts.get(cid, 0) == 0:
                continue
            msgs = _load_messages(cid)
            base = _safe_filename(c.get("title") or cid) + "__" + cid[:8]
            if fmt == "jsonl":
                zf.writestr(f"{base}.jsonl", _messages_jsonl(msgs))
            elif fmt == "md":
                zf.writestr(f"{base}.md", _render_markdown(c, _branches(msgs)))
            else:
                for fname, content in _branch_files(c, _branches(msgs)):
                    zf.writestr(f"{base}/{fname}", content)
    buf.seek(0)
    return Response(buf.read(), mimetype="application/zip",
                    headers={"Content-Disposition": f'attachment; filename="librechat_export_{fmt}.zip"'})


@app.route("/export/healthz")
def export_healthz():
    return {"ok": True, "conversations": conversations_col.estimated_document_count(),
            "messages": messages_col.estimated_document_count()}


if __name__ == "__main__":
    reconcile.start_scheduler(transactions)
    app.run(host="0.0.0.0", port=5000)
