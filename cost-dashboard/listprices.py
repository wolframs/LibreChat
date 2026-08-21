"""Provider list prices, read from the same table the api bills from.

The marketplace publishes a `direct_*_per_1m` reference alongside every offer,
but that reference is whichever seller it happened to benchmark against. On
2026-08-21 all 244 `claude-fable-5` offers carried `reference_source: "venice"`
at $12/$60, while Anthropic's own list for that model is $10/$50 — so the best
offer of $1.80/$9.00 reads as 85% off Venice and 82% off Anthropic. Measuring a
marketplace's spread against a reseller's marked-up catalogue flatters the
marketplace, by a different amount for every model.

So the denominator comes from `packages/data-schemas/src/methods/tx.ts`
instead — the table LibreChat actually charges a conversation with. That makes
the popup's "N% below list" and the dashboard's nominal spend two views of one
number rather than two numbers that quietly disagree, and it means the
`models.md` recipe for adding a model keeps this correct for free.

Only exact key matches count. `tokenValues` is consumed upstream through a
substring match ending in a generic `'claude-'` fallback at $0.8/$2.4; letting
that fallback stand in for a list price would report the marketplace as
charging several times list. A model with no exact entry falls back to the
marketplace's own reference, and the payload says which was used.
"""

import os
import re
import threading

#: Bind-mounted read-only from the repo (docker-compose.override.yml). Absent
#: — a stale image, a hand-run container — every model falls back to the
#: marketplace's own reference, which is the pre-existing behaviour.
TX_TS = os.environ.get("TX_TS", "/app/tx.ts")

#: One `'model-id': { prompt: N, completion: N }` line. Bare identifier keys
#: (`o1`, `deepseek`) appear unquoted in the source, hence the optional quotes.
_ENTRY = re.compile(
    r"^\s*'?(?P<key>[A-Za-z0-9._-]+)'?\s*:\s*\{\s*"
    r"prompt:\s*(?P<prompt>[\d.]+)\s*,\s*"
    r"completion:\s*(?P<completion>[\d.]+)\s*\}",
    re.MULTILINE,
)

_cache = {"mtime": None, "rates": {}}
_lock = threading.Lock()


def _parse(source):
    """Rates from the `tokenValues` declaration only.

    Bounded at both ends on purpose: `cacheTokenValues` below it uses
    write/read keys (harmless), but `premiumTokenValues` below *that* repeats
    model ids with a `threshold` and long-context rates, and would otherwise
    overwrite the standard rate for the same id.
    """
    start = source.find("export const tokenValues")
    if start < 0:
        return {}
    end = source.find("export const cacheTokenValues", start + 1)
    block = source[start : end if end > start else len(source)]
    return {
        m.group("key"): (float(m.group("prompt")), float(m.group("completion")))
        for m in _ENTRY.finditer(block)
    }


def list_prices(path=None):
    """{model id: (input, output)} in dollars per 1M tokens, cached by mtime."""
    path = path or TX_TS
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        return {}
    with _lock:
        if _cache["mtime"] == mtime:
            return _cache["rates"]
        try:
            with open(path, encoding="utf-8") as fh:
                rates = _parse(fh.read())
        except OSError:
            return {}
        _cache["mtime"] = mtime
        _cache["rates"] = rates
        return rates


def list_price(model, path=None):
    """(input, output) $/1M for `model`, or None when there is no exact rate."""
    if not model:
        return None
    return list_prices(path).get(model)
