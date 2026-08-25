import json
import os
import tempfile
import unittest
from pathlib import Path

from codex_adapter.artifacts import (
    artifact_manifest,
    changed_artifacts,
    publish_artifacts,
    snapshot_workspace,
)
from codex_adapter.config_store import FileConfigStore


class ArtifactDiscoveryTests(unittest.TestCase):
    def test_only_new_or_changed_deliverables_are_selected(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            unchanged = workspace / "existing.md"
            unchanged.write_text("old", encoding="utf-8")
            before = snapshot_workspace(workspace)

            (workspace / "report.md").write_text("# Report", encoding="utf-8")
            (workspace / "helper.py").write_text("print('work')", encoding="utf-8")
            uploads = workspace / "uploads"
            uploads.mkdir()
            (uploads / "input.pdf").write_bytes(b"input")

            self.assertEqual(
                [path.name for path in changed_artifacts(workspace, before)],
                ["report.md"],
            )

    def test_symlinks_cannot_escape_the_workspace(self):
        if not hasattr(os, "symlink"):
            self.skipTest("symlinks are not supported")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workspace = root / "workspace"
            workspace.mkdir()
            outside = root / "secret.json"
            outside.write_text('{"secret":true}', encoding="utf-8")
            before = snapshot_workspace(workspace)
            (workspace / "leak.json").symlink_to(outside)

            self.assertEqual(changed_artifacts(workspace, before), [])


class ArtifactPublishingTests(unittest.TestCase):
    def test_publishes_private_file_and_emits_invisible_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "报告.md"
            source.write_text("# 已完成", encoding="utf-8")
            store = FileConfigStore(root / "store")

            artifacts, failures = publish_artifacts([source], store)

            self.assertEqual(failures, 0)
            self.assertEqual(len(artifacts), 1)
            artifact = artifacts[0]
            self.assertEqual(artifact.name, "报告.md")
            stored = root / "store" / "artifacts" / artifact.id / artifact.name
            self.assertEqual(stored.read_text(encoding="utf-8"), "# 已完成")

            block = artifact_manifest(
                [
                    {
                        "id": artifact.id,
                        "name": artifact.name,
                        "mimeType": artifact.mimeType,
                        "size": artifact.size,
                    }
                ]
            )
            payload = json.loads(block.split(":", 1)[1].rsplit("-->", 1)[0])
            self.assertEqual(payload["artifacts"][0]["name"], "报告.md")


class ArtifactManifestTests(unittest.TestCase):
    def test_zero_failures_keeps_legacy_shape(self):
        artifacts = [
            {
                "id": "a" * 32,
                "name": "报告.md",
                "mimeType": "text/markdown",
                "size": 10,
            }
        ]

        self.assertEqual(
            artifact_manifest(artifacts, failed=0),
            '\n\n<!-- digibuddy-artifacts:{"version":1,"artifacts":[{"id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","name":"报告.md","mimeType":"text/markdown","size":10}]} -->',
        )

    def test_non_zero_failures_are_recorded_in_the_manifest(self):
        block = artifact_manifest([], failed=2)
        payload = json.loads(block.split(":", 1)[1].rsplit("-->", 1)[0])

        self.assertEqual(
            block,
            '\n\n<!-- digibuddy-artifacts:{"version":1,"artifacts":[],"failed":2} -->',
        )
        self.assertEqual(payload, {"version": 1, "artifacts": [], "failed": 2})


if __name__ == "__main__":
    unittest.main()


class LegacyRootTests(unittest.TestCase):
    def test_the_shared_root_does_not_collect_other_conversations(self):
        """A conversation bound before containment still scans the root."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "mine.md").write_text("# mine", encoding="utf-8")
            neighbour = root / "conversations" / ("a" * 8)
            neighbour.mkdir(parents=True)
            (neighbour / "theirs.md").write_text("# theirs", encoding="utf-8")

            changed = changed_artifacts(root, {})

            self.assertEqual([path.name for path in changed], ["mine.md"])
