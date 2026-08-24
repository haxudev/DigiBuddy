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

    def test_corrupt_map_is_visible_and_does_not_break_new_sessions(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "mappings.json"
            path.write_text("{", encoding="utf-8")

            with self.assertLogs("codex_adapter.session_map", level="WARNING"):
                self.assertIsNone(ResponseThreadMap(path).lookup("response-1"))


if __name__ == "__main__":
    unittest.main()

class WorkspaceBindingTests(unittest.TestCase):
    """The workspace id has to outlive the process that created it."""

    def test_a_binding_carries_its_workspace(self):
        with tempfile.TemporaryDirectory() as directory:
            mapping = ResponseThreadMap(Path(directory) / "map.json")
            mapping.bind("r1", "thread-1", "marketing", "ws-abc")

            binding = mapping.lookup("r1")
            self.assertEqual(binding.workspace_id, "ws-abc")

    def test_a_map_written_before_workspaces_existed_still_loads(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "map.json"
            path.write_text(
                json.dumps({"r1": {"thread": "t1", "profile": "marketing"}}),
                encoding="utf-8",
            )

            binding = ResponseThreadMap(path).lookup("r1")

            self.assertEqual(binding.thread_id, "t1")
            self.assertEqual(binding.workspace_id, "")
