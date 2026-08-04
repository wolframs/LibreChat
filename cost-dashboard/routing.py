"""Where a request went, and whether that makes its recorded price trustworthy.

A transaction carries `routedVia` when it was sent somewhere other than the
provider's own API — a yaml `endpoints.custom` row, or an env reverse proxy.
That is provenance, not a verdict: it says *where*, not *whether the number is
right*. The two questions are separate and were previously conflated, which had
the effect of flagging OpenRouter — the one destination in this install with
exact per-request pricing — as an estimate.

Three states exist, decided by the destination host:

    exact        the recorded `rate` is what was actually charged
    nominal      an estimate from the model-name rate table, unsettleable
    reconcilable an estimate now, replaced by the gateway's own billing later

`rate` is exact when nothing redirected the request, when it was redirected but
still landed on the provider's own API, or when the destination publishes a price
catalogue LibreChat fetches (`FetchTokenConfig` in
`packages/data-provider/src/config.ts` — currently OpenRouter and Helicone).
Anywhere else, the rate came from the model-name table and describes what the
model's own provider would have charged. A marketplace that re-routes to
whichever seller is cheapest is invisible to that table.

Adding a gateway means adding one hostname below, and nothing else.
"""

import re
from urllib.parse import urlsplit

#: The providers' own APIs. The model-name rate table *is* their price list, so a
#: request that lands here is priced exactly even though something redirected it
#: — an env reverse proxy, or a base URL that happens to name the provider.
PROVIDER_HOSTS = {
    "api.anthropic.com",
    "api.openai.com",
}

#: Gateways that report their own per-request prices, which LibreChat fetches into
#: `endpointTokenConfig` and bills from. Spend through these is as accurate as a
#: direct call. Keep in step with `FetchTokenConfig`.
CATALOGUE_PRICED_HOSTS = {
    "openrouter.ai",
    "api.helicone.ai",
}

#: Everywhere the recorded rate equals what was actually charged, for either
#: reason above.
EXACTLY_PRICED_HOSTS = PROVIDER_HOSTS | CATALOGUE_PRICED_HOSTS

#: Gateways whose real charges can be pulled and settled afterwards. Each needs a
#: reconciler that knows how to fetch its billing export; see `reconcile.py`.
RECONCILABLE_HOSTS = {
    "api.surplusintelligence.ai",
}


def host_of(url):
    """Lowercased hostname of `url`, or None if it isn't a parseable URL."""
    if not url:
        return None
    try:
        hostname = urlsplit(url).hostname
    except ValueError:
        return None
    return hostname.lower() if hostname else None


def is_exactly_priced(url):
    """Whether spend sent to `url` is recorded at the price actually charged.

    True for a missing URL — nothing redirected the request, so it went straight
    to the provider whose rates the table describes.
    """
    host = host_of(url)
    return host is None or host in EXACTLY_PRICED_HOSTS


def is_reconcilable(url):
    """Whether `url` names a gateway whose real charges can be settled later."""
    return host_of(url) in RECONCILABLE_HOSTS


#: Mongo expression: true when this transaction's price is an estimate rather
#: than a charge — the aggregation-pipeline form of `is_exactly_priced`.
#:
#: A transaction is estimated when it carries a destination URL whose host is not
#: in `EXACTLY_PRICED_HOSTS`. The trailing lookahead stops a lookalike host
#: (`openrouter.ai.example.com`) from matching the prefix.
IS_ESTIMATED = {
    "$and": [
        {"$ne": [{"$type": "$routedVia.baseURL"}, "missing"]},
        {
            "$not": {
                "$regexMatch": {
                    "input": {"$ifNull": ["$routedVia.baseURL", ""]},
                    "regex": r"^https?://("
                    + "|".join(re.escape(h) for h in sorted(EXACTLY_PRICED_HOSTS))
                    + r")(?![\w.-])",
                    "options": "i",
                }
            }
        },
    ]
}
