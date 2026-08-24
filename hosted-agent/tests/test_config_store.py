import json
import tempfile
import unittest
from pathlib import Path

from codex_adapter.config_store import (
    SCHEMA_VERSION,
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

    def test_an_unreadable_future_schema_keeps_the_last_good_document(self):
        """A newer console must not be able to silently widen an older runtime.

        Reinterpreting a document written to a schema this build does not know
        is how a capability restriction quietly disappears, so the runtime keeps
        what it last understood instead.
        """
        with tempfile.TemporaryDirectory() as directory:
            inner = FileConfigStore(Path(directory))
            inner.write(
                "profiles.json",
                {"schema_version": SCHEMA_VERSION, "profiles": [{"name": "good"}]},
            )
            store = CachingConfigStore(inner, ttl_seconds=0)
            self.assertEqual(store.read("profiles.json")["profiles"], [{"name": "good"}])

            inner.write(
                "profiles.json",
                {"schema_version": SCHEMA_VERSION + 1, "profiles": [{"name": "future"}]},
            )

            self.assertEqual(store.read("profiles.json")["profiles"], [{"name": "good"}])


class SchemaVersionTests(unittest.TestCase):
    def test_a_legacy_unversioned_document_is_still_readable(self):
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory) / "profiles.json").write_text(
                json.dumps({"profiles": [{"name": "legacy"}]}), encoding="utf-8"
            )

            document = FileConfigStore(Path(directory)).read("profiles.json")

            self.assertEqual(document["profiles"], [{"name": "legacy"}])

    def test_a_future_schema_reads_as_absent_without_a_last_good_value(self):
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory) / "profiles.json").write_text(
                json.dumps({"schema_version": SCHEMA_VERSION + 1, "profiles": []}),
                encoding="utf-8",
            )

            self.assertIsNone(FileConfigStore(Path(directory)).read("profiles.json"))

    def test_a_non_integer_schema_version_is_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory) / "profiles.json").write_text(
                json.dumps({"schema_version": "one", "profiles": []}), encoding="utf-8"
            )

            self.assertIsNone(FileConfigStore(Path(directory)).read("profiles.json"))


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


class ArtifactOwnerTests(unittest.TestCase):
    """A signed-in account must not be able to address another's files."""

    def test_files_are_partitioned_by_owner(self):
        artifact, owner = "a" * 32, "b" * 32

        self.assertEqual(
            artifact_path(artifact, "report.pdf", owner),
            f"artifacts/{owner}/{artifact}/report.pdf",
        )

    def test_the_flat_layout_still_resolves(self):
        """Files made before anyone could sign in must stay reachable."""
        artifact = "a" * 32

        self.assertEqual(
            artifact_path(artifact, "report.pdf"),
            f"artifacts/{artifact}/report.pdf",
        )

    def test_an_owner_that_is_not_an_owner_key_is_refused(self):
        artifact = "a" * 32

        for bad in ("../../etc", "short", "B" * 32, f"{'b' * 31}/x"):
            with self.assertRaises(ValueError, msg=f"{bad} should be refused"):
                artifact_path(artifact, "report.pdf", bad)

    def test_two_owners_never_collide_on_the_same_id(self):
        artifact = "a" * 32

        self.assertNotEqual(
            artifact_path(artifact, "r.pdf", "b" * 32),
            artifact_path(artifact, "r.pdf", "c" * 32),
        )


class BundlePathGrammarTests(unittest.TestCase):
    def test_both_separators_are_accepted(self):
        digest = "a" * 64
        with tempfile.TemporaryDirectory() as directory:
            store = FileConfigStore(Path(directory))
            for name in ("agent-maturity-assess", "release_notes", "x1"):
                # Reading a missing bundle is None; the point is that the path
                # itself is not rejected before the lookup happens.
                self.assertIsNone(store.read_bundle(f"bundles/{name}/{digest}.zip"))

    def test_a_traversing_bundle_path_is_still_refused(self):
        digest = "a" * 64
        with tempfile.TemporaryDirectory() as directory:
            store = FileConfigStore(Path(directory))
            for bad in (f"bundles/../{digest}.zip", f"bundles/a b/{digest}.zip",
                        f"other/x/{digest}.zip", f"bundles/x/{digest}.txt"):
                with self.assertRaises(ValueError, msg=f"{bad} should be refused"):
                    store.read_bundle(bad)
