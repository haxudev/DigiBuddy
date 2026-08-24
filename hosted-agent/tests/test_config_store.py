import json
import tempfile
import unittest
from pathlib import Path

from codex_adapter.config_store import (
    CachingConfigStore,
    FileConfigStore,
    NullConfigStore,
    artifact_path,
    build_config_store,
)


class FileConfigStoreTests(unittest.TestCase):
    def test_round_trips_a_document(self):
        with tempfile.TemporaryDirectory() as directory:
            store = FileConfigStore(Path(directory))
            store.write("models.json", {"model": "gpt-5.2"})

            self.assertEqual(store.read("models.json"), {"model": "gpt-5.2"})

    def test_missing_document_reads_as_none(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertIsNone(FileConfigStore(Path(directory)).read("models.json"))

    def test_corrupt_document_reads_as_none(self):
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory) / "models.json").write_text("{ not json", encoding="utf-8")

            self.assertIsNone(FileConfigStore(Path(directory)).read("models.json"))

    def test_unknown_document_names_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            store = FileConfigStore(Path(directory))

            with self.assertRaises(ValueError):
                store.read("../../etc/passwd")
            with self.assertRaises(ValueError):
                store.write("secrets.json", {})

    def test_artifacts_are_pinned_below_the_reserved_prefix(self):
        with tempfile.TemporaryDirectory() as directory:
            store = FileConfigStore(Path(directory))
            artifact_id = "a" * 32

            self.assertTrue(
                store.write_artifact(
                    artifact_id, "报告.md", b"# report", "text/markdown"
                )
            )
            self.assertEqual(
                (Path(directory) / "artifacts" / artifact_id / "报告.md").read_bytes(),
                b"# report",
            )
            with self.assertRaises(ValueError):
                artifact_path(artifact_id, "../models.json")
            with self.assertRaises(ValueError):
                artifact_path("not-an-id", "report.md")


class CachingConfigStoreTests(unittest.TestCase):
    def test_repeated_reads_hit_the_backend_once(self):
        with tempfile.TemporaryDirectory() as directory:
            inner = FileConfigStore(Path(directory))
            inner.write("models.json", {"model": "a"})
            store = CachingConfigStore(inner, ttl_seconds=300)

            self.assertEqual(store.read("models.json"), {"model": "a"})
            (Path(directory) / "models.json").write_text(
                json.dumps({"model": "b"}), encoding="utf-8"
            )
            self.assertEqual(store.read("models.json"), {"model": "a"})

    def test_writing_invalidates_the_cached_document(self):
        with tempfile.TemporaryDirectory() as directory:
            store = CachingConfigStore(FileConfigStore(Path(directory)), ttl_seconds=300)
            store.write("models.json", {"model": "a"})
            self.assertEqual(store.read("models.json"), {"model": "a"})

            store.write("models.json", {"model": "b"})

            self.assertEqual(store.read("models.json"), {"model": "b"})


class BuildConfigStoreTests(unittest.TestCase):
    def test_no_configuration_yields_no_overlay(self):
        store = build_config_store({})

        self.assertIsInstance(store, NullConfigStore)
        self.assertIsNone(store.read("models.json"))

    def test_directory_configuration_yields_a_file_store(self):
        with tempfile.TemporaryDirectory() as directory:
            store = build_config_store({"DIGIBUDDY_CONFIG_DIR": directory})
            store.write("models.json", {"model": "a"})

            self.assertEqual(store.read("models.json"), {"model": "a"})

    def test_plaintext_container_uri_is_refused(self):
        with self.assertRaisesRegex(RuntimeError, "HTTPS"):
            build_config_store({"DIGIBUDDY_CONFIG_URI": "http://example.com/c"})


if __name__ == "__main__":
    unittest.main()
