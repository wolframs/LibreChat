"""Tests for destination classification.

The point of `routing.py` is that "where did this go" and "can I trust the price"
are different questions. These pin that apart, and pin the Python and Mongo forms
of the same rule to each other.
"""

import re

import pytest

from routing import (
    CATALOGUE_PRICED_HOSTS,
    EXACTLY_PRICED_HOSTS,
    IS_ESTIMATED,
    PROVIDER_HOSTS,
    RECONCILABLE_HOSTS,
    host_of,
    is_exactly_priced,
    is_reconcilable,
)


class TestHostOf:
    @pytest.mark.parametrize(
        "url,expected",
        [
            ("https://api.anthropic.com", "api.anthropic.com"),
            ("https://api.surplusintelligence.ai/anthropic", "api.surplusintelligence.ai"),
            ("https://OpenRouter.AI/api/v1", "openrouter.ai"),
            ("http://localhost:11434/v1", "localhost"),
            ("", None),
            (None, None),
            ("not a url", None),
        ],
    )
    def test_extracts_hostname(self, url, expected):
        assert host_of(url) == expected


class TestIsExactlyPriced:
    def test_no_url_means_straight_to_the_provider(self):
        """An unstamped transaction was never redirected, so the table applies."""
        assert is_exactly_priced(None) is True
        assert is_exactly_priced("") is True

    def test_provider_host_is_exact_even_though_redirected(self):
        """A reverse proxy naming the provider's own API still lands on its prices."""
        assert is_exactly_priced("https://api.anthropic.com") is True
        assert is_exactly_priced("https://api.openai.com/v1") is True

    def test_catalogue_priced_gateway_is_exact(self):
        """OpenRouter publishes per-request prices that LibreChat bills from."""
        assert is_exactly_priced("https://openrouter.ai/api/v1") is True

    def test_marketplace_gateway_is_not_exact(self):
        assert is_exactly_priced("https://api.surplusintelligence.ai/anthropic") is False

    def test_unknown_gateway_is_not_exact(self):
        """Unrecognised destinations are estimates: honest, not optimistic."""
        assert is_exactly_priced("https://gateway.example.com/v1") is False

    def test_lookalike_host_does_not_pass(self):
        assert is_exactly_priced("https://openrouter.ai.evil.example.com/v1") is False

    def test_case_and_port_are_ignored(self):
        assert is_exactly_priced("HTTPS://OpenRouter.AI:443/api/v1") is True


class TestIsReconcilable:
    def test_surplus_can_be_settled(self):
        assert is_reconcilable("https://api.surplusintelligence.ai/v1") is True

    def test_exactly_priced_hosts_need_no_settling(self):
        assert is_reconcilable("https://openrouter.ai/api/v1") is False
        assert is_reconcilable("https://api.anthropic.com") is False
        assert is_reconcilable(None) is False

    def test_reconcilable_is_never_also_exact(self):
        """A host settled later must not also be reported as already accurate."""
        assert RECONCILABLE_HOSTS.isdisjoint(EXACTLY_PRICED_HOSTS)


class TestMongoExpressionMatchesPython:
    """`IS_ESTIMATED` is the pipeline form of `not is_exactly_priced`.

    It cannot import the Python helper, so the two can drift. This re-implements
    the Mongo expression's regex in Python and checks it agrees on every case.
    """

    @property
    def regex(self):
        return IS_ESTIMATED["$and"][1]["$not"]["$regexMatch"]["regex"]

    def _mongo_says_estimated(self, url):
        if url is None:
            return False
        return re.match(self.regex, url, re.IGNORECASE) is None

    @pytest.mark.parametrize(
        "url",
        [
            None,
            "https://api.anthropic.com",
            "https://api.openai.com/v1",
            "https://openrouter.ai/api/v1",
            "https://api.helicone.ai/v1",
            "https://api.surplusintelligence.ai/anthropic",
            "https://gateway.example.com/v1",
            "https://openrouter.ai.evil.example.com/v1",
            "http://localhost:11434/v1",
        ],
    )
    def test_agrees_with_python(self, url):
        assert self._mongo_says_estimated(url) is (not is_exactly_priced(url))

    def test_regex_covers_every_exactly_priced_host(self):
        for host in EXACTLY_PRICED_HOSTS:
            assert re.match(self.regex, f"https://{host}/v1", re.IGNORECASE)

    def test_expression_requires_a_stored_url(self):
        """Without `routedVia.baseURL` nothing is estimated, whatever the regex says."""
        assert IS_ESTIMATED["$and"][0] == {
            "$ne": [{"$type": "$routedVia.baseURL"}, "missing"]
        }


class TestHostSets:
    def test_exactly_priced_is_the_union(self):
        assert EXACTLY_PRICED_HOSTS == PROVIDER_HOSTS | CATALOGUE_PRICED_HOSTS

    def test_hosts_are_bare_lowercase_hostnames(self):
        """A scheme or path here would silently never match `host_of` output."""
        for host in EXACTLY_PRICED_HOSTS | RECONCILABLE_HOSTS:
            assert host == host.lower()
            assert "/" not in host and ":" not in host
