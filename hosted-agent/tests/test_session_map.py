import tempfile
import unittest
from pathlib import Path

from codex_adapter.session_map import ResponseThreadMap


class ResponseThreadMapTests(unittest.TestCase):
    def test_persists_response_to_thread_mapping(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "mappings.json"
            mapping = ResponseThreadMap(path)
            mapping.bind("response-1", "thread-1")

            self.assertEqual(ResponseThreadMap(path).lookup("response-1"), "thread-1")
            self.assertIsNone(mapping.lookup("missing"))


if __name__ == "__main__":
    unittest.main()
