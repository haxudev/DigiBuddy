import json
import tempfile
import unittest
from pathlib import Path

from codex_adapter.session_map import ResponseThreadMap


class ResponseThreadMapTests(unittest.TestCase):
    def test_persists_response_to_thread_mapping(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "mappings.json"
            mapping = ResponseThreadMap(path)
            mapping.bind("response-1", "thread-1", "marketing")

            binding = ResponseThreadMap(path).lookup("response-1")
            self.assertEqual(binding.thread_id, "thread-1")
            self.assertEqual(binding.profile, "marketing")
            self.assertIsNone(mapping.lookup("missing"))

    def test_reads_maps_written_before_profiles_existed(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "mappings.json"
            path.write_text(json.dumps({"response-1": "thread-1"}), encoding="utf-8")

            binding = ResponseThreadMap(path).lookup("response-1")
            self.assertEqual(binding.thread_id, "thread-1")
            self.assertEqual(binding.profile, "")


if __name__ == "__main__":
    unittest.main()
