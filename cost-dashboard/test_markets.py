"""Tests for the market-price proxy.

Run with `./cost-dashboard/test.sh test_markets.py` (the image carries no test
files and no pytest, so the suite runs against a mounted source tree).

The upstream payload is microdollars per 1M tokens and ~853 KB; the contract
here is that conversion happens exactly once, the response is trimmed to one
model, and one upstream fetch covers everything inside the 30 s TTL.
"""

import time

import pytest
from flask import Flask

import markets


#: Exact-match rates, standing in for tx.ts. `claude-opus-4.8` is priced here
#: BELOW the marketplace's own reference on purpose — that gap is the whole
#: reason this indirection exists.
FAKE_LIST = {"claude-opus-4.8": (5.0, 25.0), "claude-opus-5": (5.0, 25.0)}


#: A realistic upstream row — values from the live table on 2026-08-05.
OPUS_ROW = {
    "model": "claude-opus-4.8",
    "best_input_per_1m": 2_410_800,
    "best_output_per_1m": 12_054_000,
    "best_price_per_1m": 14_464_800,
    "best_cache_read_per_1m": None,
    "best_cache_write_per_1m": None,
    "direct_input_per_1m": 6_000_000,
    "direct_output_per_1m": 30_000_000,
    "best_discount_pct": 99.99,
    "discount_trend": {
        "direction": "tightening",
        "current_discount_pct": 38.01,
        "previous_discount_pct": 66.07,
        "buckets": [
            {"bucket": 1, "discount_pct": 70.41, "requests": 8},
            {"bucket": 0, "discount_pct": 66.07, "requests": 22},
            {"bucket": 2, "discount_pct": None, "requests": 0},
        ],
    },
    "healthy_seller_count": 21,
    "requests_24h": 406,
    "providers": [
        {
            "provider": "morpheus",
            "trusted": False,
            "healthy_seller_count": 1,
            "best_input_per_1m": 5_400_000,
            "best_output_per_1m": 26_990_000,
        },
        {
            "provider": "venice",
            "trusted": True,
            "healthy_seller_count": 11,
            "best_input_per_1m": 2_410_800,
            "best_output_per_1m": 12_054_000,
        },
    ],
}

#: The marketplace publishes no reference for this one.
NO_LIST_ROW = {
    "model": "claude-opus-5",
    "best_input_per_1m": 5_100_000,
    "best_output_per_1m": 25_000_000,
    "best_price_per_1m": 30_100_000,
    "direct_input_per_1m": 0,
    "direct_output_per_1m": 0,
    "providers": [],
}

#: Neither side prices it — the only case left with no denominator at all.
UNPRICED_ROW = {
    "model": "llama-4-scout",
    "best_input_per_1m": 100_000,
    "best_output_per_1m": 300_000,
    "best_price_per_1m": 400_000,
    "direct_input_per_1m": 0,
    "direct_output_per_1m": 0,
    "providers": [],
}


@pytest.fixture(autouse=True)
def fresh_caches(monkeypatch):
    markets._cache.update({"rows": None, "fetched_at": None, "expires": 0.0})
    markets._yaml_cache.update({"mtime": None, "names": []})
    monkeypatch.setattr(markets, "list_price", lambda model: FAKE_LIST.get(model))
    yield


@pytest.fixture
def client():
    app = Flask(__name__)
    app.register_blueprint(markets.bp)
    return app.test_client()


class FakeSession:
    def __init__(self, rows=None, fail=False):
        self.rows = rows if rows is not None else [OPUS_ROW, NO_LIST_ROW]
        self.fail = fail
        self.calls = 0

    def get(self, url, timeout=None):
        self.calls += 1
        if self.fail:
            raise ConnectionError("upstream down")
        session = self

        class R:
            def raise_for_status(self):
                pass

            def json(self):
                return {"markets": session.rows}

        return R()


class TestConversion:
    def test_microdollars_become_dollars(self):
        assert markets._usd(5_100_000) == 5.1
        assert markets._usd(2_410_800) == 2.4108

    def test_zero_and_none_mean_unpublished(self):
        assert markets._usd(0) is None
        assert markets._usd(None) is None


class TestReference:
    def test_provider_rate_wins_over_the_marketplace_reference(self):
        # The marketplace quotes $6/$30 "direct"; Anthropic's list is $5/$25.
        ref = markets._reference(OPUS_ROW)
        assert (ref["input"], ref["output"]) == (5.0, 25.0)
        assert ref["source"] == "provider"
        # ...and what it would have claimed is carried along, for the footnote.
        assert (ref["marketplaceInput"], ref["marketplaceOutput"]) == (6.0, 30.0)

    def test_falls_back_to_the_marketplace_for_an_unpriced_model(self, monkeypatch):
        monkeypatch.setattr(markets, "list_price", lambda model: None)
        ref = markets._reference(OPUS_ROW)
        assert (ref["input"], ref["output"]) == (6.0, 30.0)
        assert ref["source"] == "marketplace"


class TestDiscount:
    def test_blended_from_best_price_vs_provider_list(self):
        # 14.4648 vs 30.00 — not 36.00 (the marketplace's marked-up reference,
        # which would read 59.8%), and not the upstream best_discount_pct
        # (99.99), which is the single deepest offer on the book.
        assert markets._blended_discount(OPUS_ROW, markets._reference(OPUS_ROW)) == 51.8

    def test_provider_list_survives_a_missing_marketplace_reference(self):
        # Best offer $30.10 against Anthropic's $30.00 — above list. The old
        # behaviour reported None here and the overcharge went unsaid.
        ref = markets._reference(NO_LIST_ROW)
        assert ref["source"] == "provider"
        assert markets._blended_discount(NO_LIST_ROW, ref) == -0.3

    def test_no_price_on_either_side_yields_none_not_100(self):
        ref = markets._reference(UNPRICED_ROW)
        assert ref["source"] == "marketplace"
        assert markets._blended_discount(UNPRICED_ROW, ref) is None


class TestTrim:
    def test_shape(self):
        out = markets._trim(OPUS_ROW, "2026-08-05T00:00:00+00:00")
        assert out["best"] == {
            "input": 2.4108, "output": 12.054, "cacheRead": None, "cacheWrite": None,
        }
        assert out["direct"] == {
            "input": 5.0,
            "output": 25.0,
            "source": "provider",
            "marketplaceInput": 6.0,
            "marketplaceOutput": 30.0,
        }
        assert out["healthySellers"] == 21
        assert out["fetchedAt"] == "2026-08-05T00:00:00+00:00"

    def test_trend_buckets_sorted_oldest_first(self):
        trend = markets._trim(OPUS_ROW, "")["trend"]
        assert trend["direction"] == "tightening"
        assert trend["buckets"] == [66.07, 70.41, None]

    def test_sellers_cheapest_first_with_trusted_flag(self):
        sellers = markets._trim(OPUS_ROW, "")["sellers"]
        assert [s["provider"] for s in sellers] == ["venice", "morpheus"]
        assert sellers[0]["trusted"] is True
        assert sellers[0]["input"] == 2.4108
        assert sellers[0]["healthy"] == 11


class TestRoutes:
    def test_model_row(self, client, monkeypatch):
        monkeypatch.setattr(
            markets, "_fetch_rows", lambda: ({r["model"]: r for r in [OPUS_ROW]}, "t")
        )
        res = client.get("/cost/markets?model=claude-opus-4.8")
        assert res.status_code == 200
        assert res.get_json()["discountPct"] == 51.8

    def test_unknown_model_404s(self, client, monkeypatch):
        monkeypatch.setattr(markets, "_fetch_rows", lambda: ({}, "t"))
        assert client.get("/cost/markets?model=bogus").status_code == 404

    def test_bare_route_returns_summaries(self, client, monkeypatch):
        monkeypatch.setattr(
            markets,
            "_fetch_rows",
            lambda: ({r["model"]: r for r in [OPUS_ROW, NO_LIST_ROW]}, "t"),
        )
        body = client.get("/cost/markets").get_json()
        assert {m["model"] for m in body["markets"]} == {
            "claude-opus-4.8", "claude-opus-5",
        }
        # Summaries stay one line per model — no seller breakdown.
        assert "sellers" not in body["markets"][0]

    def test_upstream_failure_with_empty_cache_is_502(self, client, monkeypatch):
        # The route calls _fetch_rows() without a session; patch the module.
        monkeypatch.setattr(markets.requests, "get", FakeSession(fail=True).get)
        assert client.get("/cost/markets?model=x").status_code == 502


class TestCache:
    def test_second_fetch_inside_ttl_is_free(self):
        session = FakeSession()
        markets._fetch_rows(session)
        markets._fetch_rows(session)
        assert session.calls == 1

    def test_expired_cache_survives_upstream_failure(self):
        good = FakeSession()
        rows, _ = markets._fetch_rows(good)
        markets._cache["expires"] = time.monotonic() - 1
        bad = FakeSession(fail=True)
        stale_rows, _ = markets._fetch_rows(bad)
        assert bad.calls == 1
        assert stale_rows == rows


class TestEndpointNames:
    def test_marketplace_rows_only(self, tmp_path):
        config = tmp_path / "librechat.yaml"
        config.write_text(
            """
endpoints:
  custom:
    - name: "Surplus"
      baseURL: "https://api.surplusintelligence.ai/v1"
    - name: "Surplus (Claude)"
      baseURL: "https://api.surplusintelligence.ai/anthropic"
    - name: "OpenRouter"
      baseURL: "https://openrouter.ai/api/v1"
    - name: "Ollama"
      baseURL: "http://host.docker.internal:11434/v1"
"""
        )
        assert markets.marketplace_endpoint_names(str(config)) == [
            "Surplus",
            "Surplus (Claude)",
        ]

    def test_missing_yaml_is_empty_not_error(self, tmp_path):
        assert markets.marketplace_endpoint_names(str(tmp_path / "nope.yaml")) == []
