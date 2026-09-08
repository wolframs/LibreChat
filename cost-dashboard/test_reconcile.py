"""Tests for the Surplus reconciliation matcher.

Run inside the sidecar image:
    ./cost-dashboard/test.sh test_reconcile.py
"""

from datetime import datetime, timedelta, timezone

import reconcile


UTC = timezone.utc


class FakeTransactions:
    """Just enough of a pymongo collection to record writes."""

    def __init__(self):
        self.updates = []

    def update_one(self, query, update):
        self.updates.append((query, update))


def _group(at, model="claude-opus-4.8", out_tokens=100, values=(-300.0, -700.0)):
    docs = [
        {"_id": f"p{at.timestamp()}", "tokenType": "prompt", "tokenValue": values[0],
         "rawAmount": -1000, "createdAt": at},
        {"_id": f"c{at.timestamp()}", "tokenType": "completion", "tokenValue": values[1],
         "rawAmount": -out_tokens, "createdAt": at},
    ]
    return {
        "model": model,
        "docs": docs,
        "out_tokens": out_tokens,
        "in_tokens": 1000,
        "at": at,
        "nominal_micro": sum(abs(v) for v in values),
    }


def _row(at, model="claude-opus-4.8", out_tokens=100, request_id="r1",
         cost="0.002000", direct="0.010000"):
    return {
        "request_id": request_id,
        "created_at": at.isoformat().replace("+00:00", "Z"),
        "model": model,
        "input_tokens": "1000",
        "output_tokens": str(out_tokens),
        "buyer_cost_usd": cost,
        "direct_cost_usd": direct,
        "settlement_status": "confirmed",
        "tx_hash": "0xabc",
    }


class TestIsSurplusURL:
    def test_accepts_the_gateway(self):
        assert reconcile.is_surplus_url("https://api.surplusintelligence.ai/anthropic")
        assert reconcile.is_surplus_url("https://api.surplusintelligence.ai/v1")

    def test_rejects_everything_else(self):
        """Other gateways are settled by their own billing, not this export."""
        assert not reconcile.is_surplus_url("https://api.anthropic.com")
        assert not reconcile.is_surplus_url("https://openrouter.ai/api/v1")
        assert not reconcile.is_surplus_url("")
        assert not reconcile.is_surplus_url(None)
        assert not reconcile.is_surplus_url("not a url")


class TestParseTimestamps:
    def test_parses_the_exports_zulu_format(self):
        parsed = reconcile._parse_ts("2026-08-04T17:11:51.556Z")
        assert parsed == datetime(2026, 8, 4, 17, 11, 51, 556000, tzinfo=UTC)

    def test_rejects_junk_without_raising(self):
        assert reconcile._parse_ts("") is None
        assert reconcile._parse_ts("yesterday") is None


class TestMatchGroups:
    def test_matches_a_row_that_precedes_its_transaction(self):
        billed = datetime(2026, 8, 4, 12, 0, 0, tzinfo=UTC)
        groups = [_group(billed + timedelta(seconds=30))]

        matches, unmatched = reconcile.match_groups(groups, [_row(billed)])

        assert not unmatched
        assert len(matches) == 1
        _, entry, ambiguous = matches[0]
        assert entry["request_id"] == "r1"
        assert ambiguous is False

    def test_ignores_a_row_outside_the_window(self):
        billed = datetime(2026, 8, 4, 12, 0, 0, tzinfo=UTC)
        groups = [_group(billed + reconcile.MAX_LAG + timedelta(seconds=1))]

        matches, unmatched = reconcile.match_groups(groups, [_row(billed)])

        assert not matches
        assert len(unmatched) == 1

    def test_ignores_a_row_that_postdates_the_transaction(self):
        """A request billed after the transaction was written is a different request."""
        written = datetime(2026, 8, 4, 12, 0, 0, tzinfo=UTC)
        groups = [_group(written)]
        late = _row(written + reconcile.MAX_LEAD + timedelta(seconds=1))

        matches, _ = reconcile.match_groups(groups, [late])

        assert not matches

    def test_requires_the_model_and_output_tokens_to_agree(self):
        billed = datetime(2026, 8, 4, 12, 0, 0, tzinfo=UTC)
        groups = [_group(billed + timedelta(seconds=5))]

        wrong_model = _row(billed, model="claude-sonnet-5")
        wrong_tokens = _row(billed, out_tokens=101)

        matches, unmatched = reconcile.match_groups(groups, [wrong_model, wrong_tokens])

        assert not matches
        assert len(unmatched) == 1

    def test_consumes_each_billing_record_once(self):
        """Two identical requests must not both settle against the same row."""
        billed = datetime(2026, 8, 4, 12, 0, 0, tzinfo=UTC)
        groups = [
            _group(billed + timedelta(seconds=10)),
            _group(billed + timedelta(seconds=20)),
        ]
        rows = [_row(billed, request_id="r1"), _row(billed + timedelta(seconds=11), request_id="r2")]

        matches, unmatched = reconcile.match_groups(groups, rows)

        assert len(matches) == 2
        assert not unmatched
        assert {entry["request_id"] for _, entry, _ in matches} == {"r1", "r2"}

    def test_pairs_the_nearest_in_time_first(self):
        billed = datetime(2026, 8, 4, 12, 0, 0, tzinfo=UTC)
        near = _group(billed + timedelta(seconds=2))
        far = _group(billed + timedelta(seconds=600))
        rows = [_row(billed, request_id="close"),
                _row(billed + timedelta(seconds=599), request_id="distant")]

        matches, _ = reconcile.match_groups([far, near], rows)

        by_group = {id(g): entry["request_id"] for g, entry, _ in matches}
        assert by_group[id(near)] == "close"
        assert by_group[id(far)] == "distant"

    def test_flags_a_group_that_several_records_could_explain(self):
        billed = datetime(2026, 8, 4, 12, 0, 0, tzinfo=UTC)
        groups = [_group(billed + timedelta(seconds=30))]
        rows = [_row(billed, request_id="r1"),
                _row(billed + timedelta(seconds=1), request_id="r2")]

        matches, _ = reconcile.match_groups(groups, rows)

        assert len(matches) == 1
        assert matches[0][2] is True

    def test_leaves_a_group_unmatched_when_no_record_exists(self):
        matches, unmatched = reconcile.match_groups(
            [_group(datetime(2026, 8, 4, 12, 0, 0, tzinfo=UTC))], []
        )
        assert not matches
        assert len(unmatched) == 1


class TestLoadPendingGroups:
    class FakeCursor(list):
        pass

    class FakeFind:
        def __init__(self, docs):
            self.docs = docs

        def find(self, *_args, **_kwargs):
            return iter(self.docs)

    def test_separates_the_reply_from_its_title_generation(self):
        """Both carry the same messageId but are billed as separate requests."""
        at = datetime(2026, 8, 4, 17, 34, 30, tzinfo=UTC)
        routed = {"baseURL": "https://api.surplusintelligence.ai/v1"}
        docs = [
            {"_id": 1, "messageId": "m1", "context": "message", "model": "deepseek-v4-flash",
             "tokenType": "prompt", "rawAmount": -9, "tokenValue": -0.81,
             "createdAt": at, "routedVia": routed},
            {"_id": 2, "messageId": "m1", "context": "message", "model": "deepseek-v4-flash",
             "tokenType": "completion", "rawAmount": -22, "tokenValue": -3.96,
             "createdAt": at, "routedVia": routed},
            {"_id": 3, "messageId": "m1", "context": "title", "model": "deepseek-v4-flash",
             "tokenType": "prompt", "rawAmount": -43, "tokenValue": -3.87,
             "createdAt": at, "routedVia": routed},
            {"_id": 4, "messageId": "m1", "context": "title", "model": "deepseek-v4-flash",
             "tokenType": "completion", "rawAmount": -236, "tokenValue": -42.48,
             "createdAt": at, "routedVia": routed},
        ]

        groups = reconcile.load_pending_groups(self.FakeFind(docs))

        assert len(groups) == 2
        assert sorted(g["out_tokens"] for g in groups) == [22, 236]
        assert sorted(g["in_tokens"] for g in groups) == [9, 43]

    def test_skips_transactions_routed_through_another_gateway(self):
        at = datetime(2026, 8, 4, 17, 34, 30, tzinfo=UTC)
        docs = [
            {"_id": 1, "messageId": "m1", "context": "message", "model": "claude-haiku-4-5",
             "tokenType": "prompt", "rawAmount": -41, "tokenValue": -41, "createdAt": at,
             "routedVia": {"baseURL": "https://api.anthropic.com"}},
        ]

        assert reconcile.load_pending_groups(self.FakeFind(docs)) == []


class TestApplyMatch:
    def test_splits_the_request_cost_by_nominal_weight(self):
        """The parts must sum to the billed total and keep the in/out ratio."""
        at = datetime(2026, 8, 4, 12, 0, 0, tzinfo=UTC)
        group = _group(at, values=(-300.0, -700.0))
        entry = reconcile._index_rows([_row(at)])[("claude-opus-4.8", 100)][0]
        fake = FakeTransactions()

        assert reconcile.apply_match(fake, group, entry, False) == 2

        shares = [u[1]["$set"]["reconciled"]["costUSD"] for u in fake.updates]
        assert shares == [0.002 * 0.3, 0.002 * 0.7]
        assert abs(sum(shares) - 0.002) < 1e-12

    def test_falls_back_to_token_counts_when_nothing_was_priced(self):
        at = datetime(2026, 8, 4, 12, 0, 0, tzinfo=UTC)
        group = _group(at, values=(0.0, 0.0))
        entry = reconcile._index_rows([_row(at)])[("claude-opus-4.8", 100)][0]
        fake = FakeTransactions()

        reconcile.apply_match(fake, group, entry, False)

        shares = [u[1]["$set"]["reconciled"]["costUSD"] for u in fake.updates]
        # 1000 input tokens vs 100 output tokens
        assert abs(sum(shares) - 0.002) < 1e-12
        assert shares[0] > shares[1]

    def test_records_the_provenance_needed_to_audit_a_row(self):
        at = datetime(2026, 8, 4, 12, 0, 0, tzinfo=UTC)
        entry = reconcile._index_rows([_row(at)])[("claude-opus-4.8", 100)][0]
        fake = FakeTransactions()

        reconcile.apply_match(fake, _group(at), entry, True)

        written = fake.updates[0][1]["$set"]["reconciled"]
        assert written["source"] == "surplus"
        assert written["requestId"] == "r1"
        assert written["requestCostUSD"] == 0.002
        assert written["requestDirectUSD"] == 0.01
        assert written["settlementStatus"] == "confirmed"
        assert written["txHash"] == "0xabc"
        assert written["ambiguous"] is True

    def test_never_overwrites_the_nominal_value(self):
        """`tokenValue` stays as recorded so a bad match can be undone."""
        at = datetime(2026, 8, 4, 12, 0, 0, tzinfo=UTC)
        entry = reconcile._index_rows([_row(at)])[("claude-opus-4.8", 100)][0]
        fake = FakeTransactions()

        reconcile.apply_match(fake, _group(at), entry, False)

        for _, update in fake.updates:
            assert set(update.keys()) == {"$set"}
            assert set(update["$set"].keys()) == {"reconciled"}


class TestRunOnce:
    def test_reports_a_clear_error_without_a_key(self, monkeypatch):
        monkeypatch.setattr(reconcile, "SURPLUS_API_KEY", "")
        result = reconcile.run_once(FakeTransactions())
        assert result["ok"] is False
        assert "SURPLUS_API_KEY" in result["error"]


class FakeUsage:
    """`mcp_image_gen_usage` stand-in: a list of docs plus recorded writes."""

    def __init__(self, docs):
        self.docs = docs
        self.updates = []

    def find(self, _query, _projection=None):
        return iter([d for d in self.docs if "reconciled" not in d and d.get("provider") == "surplus"])

    def update_one(self, query, update):
        self.updates.append((query, update))


def _image_row(at, model="venice-sd35", request_id="i1", cost="0.003500", direct="0.010000"):
    return {
        "request_id": request_id,
        "created_at": at.isoformat().replace("+00:00", "Z"),
        "model": model,
        "input_tokens": "0",
        "output_tokens": "0",
        "buyer_cost_usd": cost,
        "direct_cost_usd": direct,
        "settlement_status": "accrued",
        "tx_hash": "",
    }


class TestReconcileImageUsage:
    """Measured 2026-09-08: export rows for image calls carry 0/0 tokens and a
    `created_at` within a second of the sidecar's `requestedAt`, while the
    sidecar's `createdAt` lands 15–80 s later, after generation."""

    def test_matches_on_model_and_request_time(self):
        sent = datetime(2026, 9, 8, 14, 33, 9, tzinfo=UTC)
        usage = FakeUsage([
            {"_id": "u1", "provider": "surplus", "model": "venice-sd35",
             "requestedAt": sent, "createdAt": sent + timedelta(seconds=28)},
        ])
        rows = [_image_row(sent + timedelta(seconds=1))]

        matched, ambiguous, unmatched = reconcile.reconcile_image_usage(usage, rows)

        assert (matched, ambiguous, unmatched) == (1, 0, 0)
        (query, update), = usage.updates
        assert query == {"_id": "u1"}
        rec = update["$set"]["reconciled"]
        assert rec["requestId"] == "i1"
        assert rec["costUSD"] == 0.0035
        assert rec["directUSD"] == 0.01
        assert rec["ambiguous"] is False

    def test_ignores_chat_rows_for_the_same_model_name(self):
        sent = datetime(2026, 9, 8, 14, 33, 9, tzinfo=UTC)
        usage = FakeUsage([
            {"_id": "u1", "provider": "surplus", "model": "venice-sd35", "requestedAt": sent},
        ])
        rows = [_row(sent, model="venice-sd35", out_tokens=12)]

        assert reconcile.reconcile_image_usage(usage, rows) == (0, 0, 1)
        assert usage.updates == []

    def test_outside_the_window_stays_pending(self):
        sent = datetime(2026, 9, 8, 14, 33, 9, tzinfo=UTC)
        usage = FakeUsage([
            {"_id": "u1", "provider": "surplus", "model": "venice-sd35", "requestedAt": sent},
        ])
        rows = [_image_row(sent + timedelta(minutes=10))]

        assert reconcile.reconcile_image_usage(usage, rows) == (0, 0, 1)

    def test_two_in_range_are_paired_nearest_first_and_flagged(self):
        sent = datetime(2026, 9, 8, 14, 33, 9, tzinfo=UTC)
        usage = FakeUsage([
            {"_id": "u1", "provider": "surplus", "model": "venice-sd35", "requestedAt": sent},
            {"_id": "u2", "provider": "surplus", "model": "venice-sd35",
             "requestedAt": sent + timedelta(seconds=60)},
        ])
        rows = [
            _image_row(sent + timedelta(seconds=1), request_id="a"),
            _image_row(sent + timedelta(seconds=61), request_id="b"),
        ]

        matched, ambiguous, unmatched = reconcile.reconcile_image_usage(usage, rows)

        assert (matched, unmatched) == (2, 0)
        assert ambiguous == 2
        pairs = {q["_id"]: u["$set"]["reconciled"]["requestId"] for q, u in usage.updates}
        assert pairs == {"u1": "a", "u2": "b"}

    def test_openrouter_rows_are_not_touched(self):
        sent = datetime(2026, 9, 8, 14, 33, 9, tzinfo=UTC)
        usage = FakeUsage([
            {"_id": "u1", "provider": "openrouter", "model": "meta/muse-image", "requestedAt": sent},
        ])
        assert reconcile.reconcile_image_usage(usage, [_image_row(sent)]) == (0, 0, 0)
