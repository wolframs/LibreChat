"""Tests for the buyer-account proxy.

Run with `./cost-dashboard/test.sh test_buyer.py` (the image carries no test
files and no pytest, so the suite runs against a mounted source tree).

The contract: microdollars (string or int) become dollars exactly once,
`/v1/buyer/me` and `/v1/buyer/savings` are merged and joined per-model even
when one side is missing a model the other has, the two upstream calls fail
independently, one upstream round-trip covers the 60 s TTL, a stale snapshot
is served on error, and an absent API key degrades to `{"configured": false}`
rather than an error.
"""

import time

import pytest
from flask import Flask

import buyer


ME = {
    "wallet": "0xabc",
    "balance_usdc": "0",
    "allowance_usdc": "0",
    "credit_balance_usdc": "5554975",
    "settlement_contract": "0xdef",
    "stats": {
        "total_spent": 3333942,
        "total_input_tokens": 1101131,
        "total_output_tokens": 72425,
        "total_requests": 142,
    },
    "model_breakdown": [
        {
            "model": "claude-opus-4.6",
            "spent": 2578719,
            "direct_spent": 4159412,
            "input_tokens": 744833,
            "output_tokens": 36590,
            "requests": 30,
        },
        {
            "model": "claude-haiku-4.6",
            "spent": 100000,
            "direct_spent": 200000,
            "input_tokens": 50000,
            "output_tokens": 5000,
            "requests": 10,
        },
    ],
}

SAVINGS = {
    "total_saved_usdc": "2100829",
    "average_discount_pct": 28.45,
    "breakdown": [
        {"model": "claude-opus-4.6", "discount": 38, "saved": 1580693},
        {"model": "claude-sonnet-4.6", "discount": 20, "saved": 5000},
    ],
    "summary": {
        "period": "all_time",
        "request_count": 142,
        "savings_pct": 38.66,
        "total_actual_usdc": 3333942,
        "total_direct_usdc": 5434771,
        "total_saved_usdc": 2100829,
    },
    "buckets": [
        {
            "period": "2026-08-04",
            "request_count": 127,
            "savings_pct": 26.57,
            "total_actual_usdc": 2394843,
            "total_direct_usdc": 3261251,
            "total_saved_usdc": 866408,
        }
    ],
    "period": {"start": 1, "end": 2},
}


@pytest.fixture(autouse=True)
def fresh_cache():
    buyer._cache.update({"snapshot": None, "fetched_at": None, "expires": 0.0})
    yield


@pytest.fixture
def client():
    app = Flask(__name__)
    app.register_blueprint(buyer.bp)
    return app.test_client()


@pytest.fixture
def with_key(monkeypatch):
    monkeypatch.setattr(buyer, "SURPLUS_API_KEY", "test-key")


class FakeSession:
    """Routes by path suffix so /me and /savings can fail independently."""

    def __init__(self, me=ME, savings=SAVINGS, fail_me=False, fail_savings=False):
        self.me = me
        self.savings = savings
        self.fail_me = fail_me
        self.fail_savings = fail_savings
        self.calls = []

    def get(self, url, headers=None, params=None, timeout=None):
        self.calls.append(url)
        assert "test-key" in (headers or {}).get("Authorization", "")
        is_savings = url.endswith("/v1/buyer/savings")
        if is_savings:
            assert params == {"period": "daily"}
            if self.fail_savings:
                raise ConnectionError("savings down")
            body = self.savings
        else:
            if self.fail_me:
                raise ConnectionError("me down")
            body = self.me

        class R:
            def raise_for_status(self):
                pass

            def json(self):
                return body

        return R()


class TestConversion:
    def test_string_microdollars(self):
        assert buyer._usd("5554975") == 5.554975

    def test_int_microdollars(self):
        assert buyer._usd(3333942) == 3.333942

    def test_none_is_zero_not_none(self):
        # Account fields have no "unpublished" state, unlike markets._usd.
        assert buyer._usd(None) == 0.0

    def test_unparseable_is_zero(self):
        assert buyer._usd("not-a-number") == 0.0

    def test_zero_string(self):
        assert buyer._usd("0") == 0.0


class TestPerModelJoin:
    def test_merges_matching_model(self):
        rows = buyer._per_model(ME["model_breakdown"], SAVINGS["breakdown"])
        opus = next(r for r in rows if r["model"] == "claude-opus-4.6")
        assert opus["spent"] == pytest.approx(2.578719)
        assert opus["direct"] == pytest.approx(4.159412)
        assert opus["saved"] == pytest.approx(1.580693)
        assert opus["discountPct"] == 38
        assert opus["requests"] == 30

    def test_model_present_only_in_spend(self):
        rows = buyer._per_model(ME["model_breakdown"], SAVINGS["breakdown"])
        haiku = next(r for r in rows if r["model"] == "claude-haiku-4.6")
        assert haiku["spent"] == pytest.approx(0.1)
        assert haiku["saved"] == 0.0
        assert haiku["discountPct"] is None

    def test_model_present_only_in_savings(self):
        rows = buyer._per_model(ME["model_breakdown"], SAVINGS["breakdown"])
        sonnet = next(r for r in rows if r["model"] == "claude-sonnet-4.6")
        assert sonnet["spent"] == 0.0
        assert sonnet["requests"] == 0
        assert sonnet["saved"] == pytest.approx(0.005)
        assert sonnet["discountPct"] == 20

    def test_sorted_by_spent_descending(self):
        rows = buyer._per_model(ME["model_breakdown"], SAVINGS["breakdown"])
        spents = [r["spent"] for r in rows]
        assert spents == sorted(spents, reverse=True)

    def test_empty_inputs(self):
        assert buyer._per_model(None, None) == []
        assert buyer._per_model([], []) == []


class TestMerge:
    def test_shape(self):
        out = buyer._merge(ME, SAVINGS, "2026-08-21T00:00:00+00:00")
        assert out["configured"] is True
        assert out["creditBalance"] == pytest.approx(5.554975)
        assert out["balance"] == 0.0
        assert out["allowance"] == 0.0
        assert out["spent"] == pytest.approx(3.333942)
        assert out["requests"] == 142
        assert out["inputTokens"] == 1101131
        assert out["outputTokens"] == 72425
        assert out["savedUSD"] == pytest.approx(2.100829)
        assert out["directUSD"] == pytest.approx(5.434771)
        assert out["savingsPct"] == 38.66
        assert out["requestCount"] == 142
        assert len(out["perModel"]) == 3
        assert out["fetchedAt"] == "2026-08-21T00:00:00+00:00"

    def test_buckets(self):
        out = buyer._merge(ME, SAVINGS, "t")
        assert out["buckets"] == [
            {
                "period": "2026-08-04",
                "spent": pytest.approx(2.394843),
                "direct": pytest.approx(3.261251),
                "saved": pytest.approx(0.866408),
                "savingsPct": 26.57,
                "requests": 127,
            }
        ]

    def test_missing_me_or_savings_degrades_gracefully(self):
        out = buyer._merge({}, {}, "t")
        assert out["spent"] == 0.0
        assert out["savedUSD"] == 0.0
        assert out["perModel"] == []
        assert out["buckets"] == []


class TestRoute:
    def test_unconfigured_without_key(self, client, monkeypatch):
        monkeypatch.setattr(buyer, "SURPLUS_API_KEY", "")
        res = client.get("/cost/buyer")
        assert res.status_code == 200
        assert res.get_json() == {"configured": False}

    def test_configured_success(self, client, with_key, monkeypatch):
        monkeypatch.setattr(
            buyer, "_fetch_snapshot", lambda: ((ME, SAVINGS), "t")
        )
        res = client.get("/cost/buyer")
        assert res.status_code == 200
        body = res.get_json()
        assert body["configured"] is True
        assert body["creditBalance"] == pytest.approx(5.554975)

    def test_upstream_failure_with_empty_cache_is_502(self, client, with_key, monkeypatch):
        def boom():
            raise RuntimeError("both /v1/buyer/me and /v1/buyer/savings failed")

        monkeypatch.setattr(buyer, "_fetch_snapshot", boom)
        res = client.get("/cost/buyer")
        assert res.status_code == 502

    def test_key_never_appears_in_response(self, client, with_key, monkeypatch):
        monkeypatch.setattr(
            buyer, "_fetch_snapshot", lambda: ((ME, SAVINGS), "t")
        )
        res = client.get("/cost/buyer")
        assert "test-key" not in res.get_data(as_text=True)


class TestCache:
    def test_second_fetch_inside_ttl_is_free(self, with_key):
        session = FakeSession()
        buyer._fetch_snapshot(session)
        buyer._fetch_snapshot(session)
        assert len(session.calls) == 2  # one /me + one /savings, once

    def test_expired_cache_refetches(self, with_key):
        session = FakeSession()
        buyer._fetch_snapshot(session)
        buyer._cache["expires"] = time.monotonic() - 1
        buyer._fetch_snapshot(session)
        assert len(session.calls) == 4

    def test_stale_snapshot_served_on_total_failure(self, with_key):
        good = FakeSession()
        snapshot, _ = buyer._fetch_snapshot(good)
        buyer._cache["expires"] = time.monotonic() - 1
        bad = FakeSession(fail_me=True, fail_savings=True)
        stale_snapshot, fetched_at = buyer._fetch_snapshot(bad)
        assert stale_snapshot == snapshot
        assert fetched_at == buyer._cache["fetched_at"]

    def test_total_failure_with_empty_cache_raises(self, with_key):
        bad = FakeSession(fail_me=True, fail_savings=True)
        with pytest.raises(RuntimeError):
            buyer._fetch_snapshot(bad)


class TestPartialFailure:
    def test_savings_down_me_up_still_returns_me_fields(self, with_key):
        session = FakeSession(fail_savings=True)
        (me, savings), _ = buyer._fetch_snapshot(session)
        assert me == ME
        assert savings == {}
        merged = buyer._merge(me, savings, "t")
        assert merged["spent"] == pytest.approx(3.333942)
        assert merged["creditBalance"] == pytest.approx(5.554975)
        assert merged["savedUSD"] == 0.0
        assert merged["buckets"] == []

    def test_me_down_savings_up_still_returns_savings_fields(self, with_key):
        session = FakeSession(fail_me=True)
        (me, savings), _ = buyer._fetch_snapshot(session)
        assert me == {}
        assert savings == SAVINGS
        merged = buyer._merge(me, savings, "t")
        assert merged["spent"] == 0.0
        assert merged["savedUSD"] == pytest.approx(2.100829)
