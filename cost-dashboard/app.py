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

import reconcile

MICRO_PER_USD = 1_000_000
ROOT_PARENT = "00000000-0000-0000-0000-000000000000"

app = Flask(__name__)
client = MongoClient(os.environ["MONGO_URI"])
db = client.get_default_database()
transactions = db["transactions"]
messages_col = db["messages"]
conversations_col = db["conversations"]


# A transaction carrying `routedVia` was served by a user endpoint profile — some
# other base URL than the provider's own API. Its `rate` still comes from the
# model-name rate table, so the cost shown for it is what the provider *would*
# have charged, not what the gateway did.
#
# `reconcile.py` later settles those against the gateway's own billing records
# and writes `reconciled.costUSD`. Three states therefore exist, and the tables
# below keep them apart so nominal spend is never presented as verified:
#
#   direct      no routedVia            — billed at the provider's real rate
#   nominal     routedVia, unreconciled — an estimate from the rate table
#   reconciled  routedVia + reconciled  — the gateway's actual charge
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
            {"$and": [{"$ifNull": ["$routedVia", False]}, {"$not": HAS_RECONCILED}]},
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
        {"$match": {**match, "routedVia": {"$exists": True}}},
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
                            "name": "$routedVia.profileName",
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


TEMPLATE = """<!doctype html>
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
footer { color: var(--dim); font-size: 0.78em; text-align: right; margin: 3em 0 1em;
         font-family: "JetBrains Mono", ui-monospace, monospace; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
</style>
</head>
<body>

<h1>LibreChat cost</h1>
<div class="subhead">Live from MongoDB <span class="mono">transactions</span>. Costs are USD; numbers reflect what LibreChat itself charged against each conversation using <span class="mono">rate × tokens</span> at message time. Rates come from the model-name table, except where a gateway's own billing records have since replaced them &mdash; see <em>By routing</em>.</div>

<div class="summary">
  <div class="card"><div class="label">Today</div><div class="value">${{ "%.4f"|format(totals.today) }}</div></div>
  <div class="card"><div class="label">Last 7 days</div><div class="value">${{ "%.4f"|format(totals.week) }}</div></div>
  <div class="card"><div class="label">Last 30 days</div><div class="value">${{ "%.4f"|format(totals.month) }}</div></div>
  <div class="card"><div class="label">All time</div><div class="value">${{ "%.4f"|format(totals.all) }}</div></div>
</div>

{% if totals.nominal > 0 %}
<div class="warn">
  <div class="warn-title">${{ "%.4f"|format(totals.nominal) }} of the all-time total is nominal, not billed</div>
  <p>That spend was served through a custom base URL (an endpoint profile), but priced from the
  model-name rate table &mdash; i.e. <em>what the provider would have charged</em>, not what the
  gateway actually did. A gateway that re-routes to a different upstream, or prices differently,
  is invisible to that table.</p>
  <p>Treat these figures as a lower-confidence estimate. The destination is recorded on each
  transaction (<span class="mono">routedVia</span>), so real rates are reconciled once the
  gateway settles them.</p>
</div>
{% endif %}

{% if savings.requests > 0 %}
<div class="note">
  {# Six decimals: the whole point of this panel is the gap between two numbers
     that four decimals would round to the same thing. #}
  <div class="note-title">${{ "%.6f"|format(savings.actual) }} settled against ${{ "%.6f"|format(savings.direct) }} at provider list &mdash; ${{ "%.6f"|format(savings.saved) }} saved ({{ "%.1f"|format(savings.pct) }}%)</div>
  <p>Measured on {{ "{:,}".format(savings.requests) }} reconciled transactions, using the gateway's
  own billing records rather than any rate table. This is the number to judge the marketplace on:
  the catalog discount describes the cheapest listed offer, this describes what was really paid.</p>
  {% if savings.ambiguous > 0 %}
  <p>{{ "{:,}".format(savings.ambiguous) }} of them matched more than one billing record within the
  time window and were settled against the nearest &mdash; identical requests, so the figures differ
  only by whatever seller prices moved in between.</p>
  {% endif %}
  <p class="dim">Last reconciliation: {{ reconcile_status }}</p>
</div>
{% endif %}

<h2>By routing</h2>
<div class="subhead">Where requests actually went. <span class="mono">Direct to provider</span> rows are priced against rates we control; gateway rows are either settled from the gateway's billing records or still nominal.</div>
<table>
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
<table>
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

<h2>By conversation</h2>
<div class="subhead">Sorted by total cost. Endpoint and model shown reflect the conversation's last-used pairing.</div>
<table>
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

<footer>Rendered {{ now }} · {{ tx_count }} transactions across {{ by_conv|length }} conversations</footer>

</body>
</html>
"""


@app.route("/cost")
@app.route("/cost/")
def index():
    now = datetime.now(timezone.utc)
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    totals = {
        "today": _cost_since(today_start),
        "week": _cost_since(now - timedelta(days=7)),
        "month": _cost_since(now - timedelta(days=30)),
        "all": _cost_since(None),
        "nominal": _nominal_since(None),
    }
    return render_template_string(
        TEMPLATE,
        totals=totals,
        savings=_savings(),
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
        return (
            f"{stamp} — matched {state.get('matched', 0)} of "
            f"{state.get('pending_groups', 0)} pending against "
            f"{state.get('export_rows', 0)} billing records"
        )
    return f"{stamp} — {state.get('error') or state.get('note') or 'not run yet'}"


@app.route("/cost/reconcile", methods=["POST"])
def reconcile_now():
    """Manual trigger, so a settle can be forced without waiting for the timer."""
    return reconcile.run_once(transactions)


@app.route("/cost/healthz")
def healthz():
    return {"ok": True, "tx": transactions.estimated_document_count()}


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
