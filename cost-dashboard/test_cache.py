"""Tests for the prompt-caching panel's arithmetic.

Run with `./cost-dashboard/test.sh test_cache.py` (the image carries no test
files and no pytest, so the suite runs against a mounted source tree).

The contract under test is the one thing on `/cost` that is a *judgement* rather
than a sum: whether prompt caching paid for itself. It is expressed as a
counterfactual — what these same tokens would have cost with caching off — using
the component rates stored with each transaction rather than one provider's
ratios for every model.
"""

import os

os.environ.setdefault("MONGO_URI", "mongodb://localhost:27017/test")

import app  # noqa: E402  (import after MONGO_URI; MongoClient is lazy and never connects here)


class CaptureTransactions:
    def __init__(self):
        self.pipelines = []

    def aggregate(self, pipeline):
        self.pipelines.append(pipeline)
        return []


def test_every_spend_summary_excludes_credit_transactions(monkeypatch):
    capture = CaptureTransactions()
    monkeypatch.setattr(app, "transactions", capture)

    app._cost_since(None)
    app._nominal_since(None)
    app._savings()
    app._by_routing()
    app._by_model()
    app._by_conversation()

    assert len(capture.pipelines) == 6
    for pipeline in capture.pipelines:
        assert pipeline[0]["$match"]["tokenType"] == {
            "$in": ["prompt", "completion"]
        }


def group(name, model, write, read, plain, actual, uncached, messages=1):
    """One `$group` output row, in micro-USD, as the aggregation emits it."""
    return {
        "_id": {"name": name, "model": model},
        "write": write,
        "read": read,
        "plain": plain,
        "actual": actual,
        "uncached": uncached,
        "messages": messages,
    }


def rated_group(name, model, write, read, plain, actual, rates, messages=1):
    row = group(name, model, write, read, plain, actual, actual, messages)
    del row["uncached"]
    row["_id"]["rates"] = rates
    return row


def test_uses_each_transactions_component_rates():
    """Kimi writes at 1x and reads at 0.25x; Anthropic uses 1.25x/0.10x."""
    kimi = rated_group(
        "Kimi", "kimi-k2", 1000, 3000, 0, 1_050, {"input": 0.6, "write": 0.6, "read": 0.15}
    )
    claude = rated_group(
        "Claude", "claude", 1000, 3000, 0, 1_550, {"input": 1, "write": 1.25, "read": 0.1}
    )

    result = app._fold_cache_rows([kimi, claude])

    by_name = {row["name"]: row for row in result["rows"]}
    assert by_name["Kimi"]["uncached"] == 0.0024
    assert by_name["Claude"]["uncached"] == 0.004


def test_legacy_rows_fall_back_to_exact_model_rate_tables():
    row = rated_group("Kimi", "kimi-k2", 1000, 3000, 0, 1_050, None)
    result = app._fold_cache_rows(
        [row], {"kimi-k2": (0.6, 2.5)}, {"kimi-k2": (0.6, 0.15)}
    )
    assert result["rows"][0]["uncached"] == 0.0024
    assert result["unpriced_messages"] == 0


def test_unknown_rates_do_not_invent_savings():
    row = rated_group("Unknown", "mystery", 1000, 3000, 0, 1_050, None, messages=2)
    result = app._fold_cache_rows([row])
    assert result["rows"][0]["uncached"] == result["rows"][0]["actual"]
    assert result["saved"] == 0
    assert result["unpriced_messages"] == 2


def test_hit_rate_is_reads_over_everything_through_the_cache():
    result = app._fold_cache_rows([group("Surplus (Claude)", "m", 1000, 3000, 0, 1.0, 1.0)])
    assert result["rows"][0]["hit_rate"] == 75.0
    assert result["hit_rate"] == 75.0


def test_hit_rate_is_zero_not_an_error_when_nothing_went_through():
    """Cannot arise from the query's own `$match`, but must not divide by zero."""
    result = app._fold_cache_rows([group("Direct to provider", "m", 0, 0, 500, 1.0, 1.0)])
    assert result["rows"][0]["hit_rate"] == 0.0


def test_saved_is_the_gap_against_the_uncached_counterfactual():
    result = app._fold_cache_rows(
        [group("Surplus (Claude)", "m", 1000, 9000, 0, 400_000, 1_000_000)]
    )
    row = result["rows"][0]
    assert row["actual"] == 0.4
    assert row["uncached"] == 1.0
    assert abs(row["saved"] - 0.6) < 1e-9
    assert abs(row["saved_pct"] - 60.0) < 1e-9


def test_saved_goes_negative_when_writes_are_never_read():
    """The failure this panel exists to make visible.

    All writes, no reads: every prefix billed at 1.25x and nothing collected, so
    caching cost 25% more than not caching. It has to show as a loss, because
    nothing else in the stack reports it — the requests all succeeded.
    """
    result = app._fold_cache_rows(
        [group("Surplus (Claude)", "m", 8000, 0, 0, 1_250_000, 1_000_000)]
    )
    row = result["rows"][0]
    assert row["hit_rate"] == 0.0
    assert row["saved"] < 0
    assert abs(row["saved"] + 0.25) < 1e-9
    assert result["saved"] < 0


def test_models_are_merged_per_destination_and_listed():
    result = app._fold_cache_rows(
        [
            group("Surplus (Claude)", "claude-opus-4.8", 100, 900, 0, 100, 200, messages=3),
            group("Surplus (Claude)", "claude-sonnet-5", 200, 800, 0, 300, 500, messages=2),
        ]
    )
    assert len(result["rows"]) == 1
    row = result["rows"][0]
    assert row["models"] == ["claude-opus-4.8", "claude-sonnet-5"]
    assert row["write"] == 300
    assert row["read"] == 1700
    assert row["messages"] == 5
    assert result["messages"] == 5


def test_a_model_appearing_twice_on_one_destination_is_not_listed_twice():
    result = app._fold_cache_rows(
        [
            group("Surplus (Claude)", "claude-opus-4.8", 100, 100, 0, 1, 2),
            group("Surplus (Claude)", "claude-opus-4.8", 100, 100, 0, 1, 2),
        ]
    )
    assert result["rows"][0]["models"] == ["claude-opus-4.8"]


def test_destinations_are_kept_apart_and_ordered_by_size():
    """The comparison that matters is marketplace against direct, side by side."""
    result = app._fold_cache_rows(
        [
            group("Surplus (Claude)", "m", 10, 90, 0, 100, 200),
            group("Direct to provider", "m", 100, 900, 0, 5_000, 9_000),
        ]
    )
    assert [r["name"] for r in result["rows"]] == ["Direct to provider", "Surplus (Claude)"]


def test_empty_input_renders_nothing_rather_than_dividing_by_zero():
    result = app._fold_cache_rows([])
    assert result["rows"] == []
    assert result["messages"] == 0
    assert result["hit_rate"] == 0.0
    assert result["saved"] == 0.0


def test_totals_are_the_sum_of_the_rows():
    rows = [
        group("Surplus (Claude)", "m", 1000, 3000, 0, 200_000, 500_000, messages=4),
        group("Direct to provider", "m", 2000, 2000, 0, 400_000, 900_000, messages=6),
    ]
    result = app._fold_cache_rows(rows)
    assert result["write"] == 3000
    assert result["read"] == 5000
    assert result["messages"] == 10
    assert abs(result["actual"] - 0.6) < 1e-9
    assert abs(result["uncached"] - 1.4) < 1e-9
    assert abs(result["saved"] - 0.8) < 1e-9
    assert abs(result["hit_rate"] - 62.5) < 1e-9


def test_token_counts_are_whole_numbers_not_floats():
    """`$abs` on a double-typed count returns a double; these are tokens."""
    result = app._fold_cache_rows([group("d", "m", 1000.0, 3000.0, 500.0, 1.0, 1.0)])
    row = result["rows"][0]
    assert row["write"] == 1000 and isinstance(row["write"], int)
    assert row["read"] == 3000 and isinstance(row["read"], int)
    assert row["plain"] == 500 and isinstance(row["plain"], int)


def test_long_model_lists_are_truncated_but_kept_whole_on_hover():
    rows = [group("d", f"model-{i}", 10, 90, 0, 1, 2) for i in range(6)]
    result = app._fold_cache_rows(rows)
    row = result["rows"][0]
    assert row["models"] == ["model-0", "model-1", "model-2", "+3 more"]
    assert row["models_all"] == "model-0, model-1, model-2, model-3, model-4, model-5"


def test_three_models_are_not_truncated():
    rows = [group("d", f"model-{i}", 10, 90, 0, 1, 2) for i in range(3)]
    result = app._fold_cache_rows(rows)
    assert result["rows"][0]["models"] == ["model-0", "model-1", "model-2"]
