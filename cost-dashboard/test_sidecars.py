"""Tests for the tool-sidecar panel's folding.

Run with `./cost-dashboard/test.sh test_sidecars.py`.

The aggregation itself runs in Mongo; what is under test is the contract
between its output and the table — that a row's confidence tag follows from
how it was priced, and that the totals the summary cards fold in are the sum
of what the table shows.
"""

import sidecars


def image_group(model, provider, calls, usd, settled_calls=0, settled_usd=0.0,
                settled_list_usd=0.0, reported_calls=0, ambiguous=0):
    return {
        "_id": {"model": model, "provider": provider},
        "calls": calls,
        "usd": usd,
        "settled_calls": settled_calls,
        "settled_usd": settled_usd,
        "settled_list_usd": settled_list_usd,
        "reported_calls": reported_calls,
        "ambiguous": ambiguous,
    }


def audio_group(model, calls, usd, reported_calls, audio_tokens=0):
    return {
        "_id": {"model": model, "provider": "openrouter"},
        "calls": calls,
        "usd": usd,
        "reported_calls": reported_calls,
        "audio_tokens": audio_tokens,
    }


class TestFoldRows:
    def test_openrouter_images_are_reported_not_settled(self):
        rows = sidecars.fold_rows([image_group("meta/muse-image", "openrouter", 13, 0.13, reported_calls=13)], [])
        (r,) = rows
        assert (r["has_reported"], r["has_settled"], r["has_list"]) == (True, False, False)
        assert r["usd"] == 0.13

    def test_surplus_row_mixes_settled_and_list_until_reconciled(self):
        """Two calls, one settled at $0.0035 against $0.01 list, one still at list."""
        rows = sidecars.fold_rows(
            [image_group("venice-sd35", "surplus", 2, 0.0135, settled_calls=1,
                         settled_usd=0.0035, settled_list_usd=0.01)], [])
        (r,) = rows
        assert r["has_settled"] and r["has_list"] and not r["has_reported"]
        assert r["list_calls"] == 1
        assert abs(r["saved"] - 0.0065) < 1e-9

    def test_audio_rows_carry_their_token_count(self):
        rows = sidecars.fold_rows([], [audio_group("google/gemini-3.8-flash", 1, 0.015792, 1, 6206)])
        (r,) = rows
        assert r["tool"] == "audio-ears" and r["unit"] == "listen"
        assert r["extra"] == "6,206 audio tokens"
        assert r["has_reported"] and not r["has_list"]

    def test_rows_are_sorted_dearest_first_across_tools(self):
        rows = sidecars.fold_rows(
            [image_group("venice-sd35", "surplus", 1, 0.0035, settled_calls=1, settled_usd=0.0035, settled_list_usd=0.01),
             image_group("meta/muse-image", "openrouter", 13, 0.13, reported_calls=13)],
            [audio_group("google/gemini-3.8-flash", 2, 0.03, 2)],
        )
        assert [r["model"] for r in rows] == ["meta/muse-image", "google/gemini-3.8-flash", "venice-sd35"]

    def test_totals_are_the_sum_of_the_rows(self):
        rows = sidecars.fold_rows(
            [image_group("venice-sd35", "surplus", 2, 0.0135, settled_calls=1, settled_usd=0.0035,
                         settled_list_usd=0.01, ambiguous=1),
             image_group("meta/muse-image", "openrouter", 3, 0.03, reported_calls=3)],
            [audio_group("google/gemini-3.8-flash", 1, 0.015792, 1)],
        )
        t = sidecars.totals_from_rows(rows)
        assert abs(t["usd"] - (0.0135 + 0.03 + 0.015792)) < 1e-9
        assert t["calls"] == 6
        assert t["list_calls"] == 1
        assert t["ambiguous"] == 1

    def test_empty_ledgers_render_nothing(self):
        rows = sidecars.fold_rows([], [])
        assert rows == []
        assert sidecars.totals_from_rows(rows)["usd"] == 0


class TestPipelineShape:
    """The two things the pipeline must get right for the numbers to mean anything."""

    def test_effective_cost_prefers_settled_then_reported_then_list(self):
        expr = sidecars.IMAGE_EFFECTIVE_USD
        assert expr["$ifNull"][0] == "$reconciled.costUSD"
        assert expr["$ifNull"][1]["$ifNull"][0] == "$cost"
        assert expr["$ifNull"][1]["$ifNull"][1]["$ifNull"] == ["$listCost", 0]

    def test_legacy_rows_get_a_provider_from_the_model_id(self):
        """Rows before 2026-09-08 have no `provider`; a slash means OpenRouter."""
        cond = sidecars.IMAGE_PROVIDER["$ifNull"][1]["$cond"]
        assert cond[0]["$regexMatch"]["regex"] == "/"
        assert cond[1:] == ["openrouter", "surplus"]

    def test_since_filter_is_applied_to_both_ledgers(self):
        from datetime import datetime, timezone
        since = datetime(2026, 9, 1, tzinfo=timezone.utc)
        assert sidecars.image_pipeline(since)[0] == {"$match": {"createdAt": {"$gte": since}}}
        assert sidecars.audio_pipeline(since)[0] == {"$match": {"createdAt": {"$gte": since}}}
        assert sidecars.image_pipeline()[0] == {"$match": {}}
