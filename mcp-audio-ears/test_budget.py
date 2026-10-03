import unittest
import tempfile
from pathlib import Path
from unittest.mock import patch

from describe_audio import budget_admission, describe_chunk


class BudgetAdmissionTests(unittest.TestCase):
    def test_allows_first_call_and_calls_below_budget(self):
        self.assertEqual(budget_admission([], 1), (True, None))
        self.assertEqual(budget_admission([{"cost": 0.4}], 1), (True, None))

    def test_stops_after_budget_is_consumed(self):
        allowed, reason = budget_admission([{"cost": 0.4}, {"cost": 0.6}], 1)
        self.assertFalse(allowed)
        self.assertIn("budget exhausted", reason)

    def test_stops_after_unknown_cost(self):
        allowed, reason = budget_admission([{"cost": None}], 1)
        self.assertFalse(allowed)
        self.assertIn("cost is unknown", reason)

    def test_rejects_non_finite_and_negative_costs(self):
        self.assertFalse(budget_admission([{"cost": float("nan")}], 1)[0])
        self.assertFalse(budget_admission([{"cost": -0.01}], 1)[0])


class UnknownDispatchTests(unittest.TestCase):
    def setUp(self):
        handle = tempfile.NamedTemporaryFile(suffix=".mp3", delete=False)
        handle.write(b"audio")
        handle.close()
        self.audio = Path(handle.name)

    def tearDown(self):
        self.audio.unlink(missing_ok=True)

    def test_malformed_json_leaves_unknown_call_sentinel(self):
        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self):
                return b"not-json"

        records = []
        with patch("describe_audio.urllib.request.urlopen", return_value=Response()):
            with self.assertRaises(ValueError):
                describe_chunk(self.audio, "prompt", "key", "model", usage_sink=records)

        self.assertEqual(len(records), 1)
        self.assertIsNone(records[0]["cost"])
        self.assertEqual(records[0]["error"], "unknown")

    def test_timeout_leaves_one_unknown_call_record(self):
        records = []
        with patch("describe_audio.urllib.request.urlopen", side_effect=TimeoutError("late")):
            result = describe_chunk(
                self.audio, "prompt", "key", "model", usage_sink=records
            )

        self.assertIn("network error", result)
        self.assertEqual(len(records), 1)
        self.assertIsNone(records[0]["cost"])
        self.assertEqual(records[0]["error"], "network")


if __name__ == "__main__":
    unittest.main()
