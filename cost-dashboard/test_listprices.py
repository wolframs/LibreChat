"""Tests for the tx.ts rate reader.

Run with `./cost-dashboard/test.sh test_listprices.py` (the image carries no test
files and no pytest, so the suite runs against a mounted source tree).

This parses TypeScript with a regex, which is only defensible because the
table is generated-looking and the failure mode is benign: an unparsed entry
falls back to the marketplace's own reference, exactly as before this module
existed. What is NOT benign is parsing the wrong entry, so most of what is
asserted here is about which lines are deliberately skipped.
"""

import os

import pytest

import listprices


#: The shape of the real file, minus 300 lines of models nobody here needs.
TX_TS_SAMPLE = """
export const someOtherThing = 6;

export const tokenValues: Record<string, { prompt: number; completion: number }> = Object.assign(
  {
    '8k': { prompt: 30, completion: 60 },
    'claude-': { prompt: 0.8, completion: 2.4 },
    deepseek: { prompt: 0.28, completion: 0.42 },
    o1: { prompt: 15, completion: 60 },
    /* Dotted ids are what gateways serve; hyphenated ids are Anthropic's own. */
    'claude-opus-4-8': { prompt: 5, completion: 25 },
    'claude-opus-4.8': { prompt: 5, completion: 25 },
    'claude-fable-5': { prompt: 10, completion: 50 },
    // Sonnet 5 introductory pricing through 2026-08-31.
    'claude-sonnet-5': { prompt: 2, completion: 10 },
  },
  bedrockValues,
);

export const cacheTokenValues: Record<string, { write: number; read: number }> = {
  'claude-fable-5': { write: 12.5, read: 1 },
};

export const premiumTokenValues: Record<
  string,
  { threshold: number; prompt: number; completion: number }
> = {
  'gpt-5.4': { threshold: 272000, prompt: 5, completion: 22.5 },
  'claude-fable-5': { threshold: 200000, prompt: 999, completion: 999 },
};
"""


@pytest.fixture(autouse=True)
def fresh_cache():
    listprices._cache.update({"mtime": None, "rates": {}})
    yield


@pytest.fixture
def tx(tmp_path):
    path = tmp_path / "tx.ts"
    path.write_text(TX_TS_SAMPLE)
    return str(path)


class TestParse:
    def test_reads_both_id_spellings(self, tx):
        assert listprices.list_price("claude-opus-4-8", tx) == (5.0, 25.0)
        assert listprices.list_price("claude-opus-4.8", tx) == (5.0, 25.0)

    def test_reads_a_fractional_rate(self, tx):
        assert listprices.list_price("deepseek", tx) == (0.28, 0.42)

    def test_takes_the_introductory_rate_verbatim(self, tx):
        """What a direct request would be billed today is the right denominator
        for "how much am I saving" — not the price list's headline."""
        assert listprices.list_price("claude-sonnet-5", tx) == (2.0, 10.0)

    def test_ignores_the_premium_long_context_table(self, tx):
        """It repeats model ids at different rates. Reading it would silently
        replace the standard rate — a doubled denominator, no error."""
        assert listprices.list_price("claude-fable-5", tx) == (10.0, 50.0)
        assert listprices.list_price("gpt-5.4", tx) is None

    def test_ignores_the_cache_rate_table(self, tx):
        """Different keys (write/read), so it cannot match — but if the regex
        is ever loosened, this is the test that notices."""
        rates = listprices.list_prices(tx)
        assert all(v != (12.5, 1.0) for v in rates.values())


class TestLookup:
    def test_matching_is_exact_not_substring(self, tx):
        """Upstream resolves rates by substring, ending at a generic 'claude-'
        fallback of $0.8/$2.4. Inheriting that here would price a $5 model at
        80 cents and report the marketplace as charging six times list."""
        assert listprices.list_price("claude-opus-4-9", tx) is None
        assert listprices.list_price("claude-fable-5-20260301", tx) is None
        # The fallback key is readable, just never reachable by a real model id.
        assert listprices.list_price("claude-", tx) == (0.8, 2.4)

    def test_empty_model_is_none(self, tx):
        assert listprices.list_price("", tx) is None
        assert listprices.list_price(None, tx) is None

    def test_missing_file_is_empty_not_error(self, tmp_path):
        """The mount is optional; without it every model falls back to the
        marketplace's reference, which is where this started."""
        assert listprices.list_prices(str(tmp_path / "nope.ts")) == {}
        assert listprices.list_price("claude-opus-5", str(tmp_path / "nope.ts")) is None

    def test_unrecognizable_file_is_empty_not_error(self, tmp_path):
        path = tmp_path / "tx.ts"
        path.write_text("export default {};\n")
        assert listprices.list_prices(str(path)) == {}


class TestCache:
    def test_reparses_when_the_file_changes(self, tmp_path):
        path = tmp_path / "tx.ts"
        path.write_text(TX_TS_SAMPLE)
        assert listprices.list_price("claude-fable-5", str(path)) == (10.0, 50.0)
        path.write_text(TX_TS_SAMPLE.replace("prompt: 10, completion: 50", "prompt: 9, completion: 45"))
        os.utime(str(path), (1_800_000_000, 1_800_000_000))
        assert listprices.list_price("claude-fable-5", str(path)) == (9.0, 45.0)


class TestAgainstTheRealTable:
    """The mount is the point; if it is wrong nothing else here proves it."""

    @pytest.fixture
    def real(self):
        for candidate in (
            listprices.TX_TS,
            "/app/tx.ts",
            os.path.join(
                os.path.dirname(__file__),
                "..",
                "packages/data-schemas/src/methods/tx.ts",
            ),
        ):
            if os.path.exists(candidate):
                return candidate
        pytest.skip("tx.ts not mounted")

    def test_the_models_this_fork_serves_are_all_priced(self, real):
        rates = listprices.list_prices(real)
        for model in (
            "claude-opus-5",
            "claude-opus-4-8",
            "claude-opus-4.8",
            "claude-sonnet-5",
            "claude-fable-5",
            "claude-haiku-4-5",
        ):
            assert model in rates, f"{model} has no exact rate — see models.md"

    def test_fable_5_is_the_provider_list_not_the_marketplace_reference(self, real):
        """$10/$50 is Anthropic's. The marketplace benchmarks fable-5 against
        venice at $12/$60, which is the discrepancy this module exists for."""
        assert listprices.list_price("claude-fable-5", real) == (10.0, 50.0)
