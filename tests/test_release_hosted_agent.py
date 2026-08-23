from __future__ import annotations

from datetime import datetime, timedelta, timezone
import unittest

from scripts.release_hosted_agent import (
    ReleaseConfig,
    extract_output_text,
    make_image_tag,
    release_receipt,
    select_source_version,
)


class MakeImageTagTests(unittest.TestCase):
    def test_make_image_tag_uses_utc_time_and_short_sha(self) -> None:
        moment = datetime(2026, 8, 23, 20, 23, 33, tzinfo=timezone(timedelta(hours=8)))

        self.assertEqual(
            make_image_tag("abc1234deadbeef", moment),
            "abc1234-20260823T122333Z",
        )


class SelectSourceVersionTests(unittest.TestCase):
    def test_select_source_version_skips_invalid_latest_and_picks_newest_valid(self) -> None:
        versions = [
            {
                "id": "older-valid",
                "created_at": "2026-08-22T10:00:00Z",
                "kind": "hosted",
                "status": "active",
                "container_configuration": {"image": "acr.example/digibuddy:old"},
                "protocols": [{"protocol": "responses", "version": "2.0.0"}],
            },
            {
                "id": "latest-invalid",
                "created_at": "2026-08-23T10:00:00Z",
                "kind": "hosted",
                "status": "active",
                "container_configuration": {"image": ""},
                "protocols": [{"protocol": "responses", "version": "2.0.0"}],
            },
            {
                "id": "newest-valid",
                "created_at": "2026-08-23T11:00:00Z",
                "kind": "hosted",
                "status": "active",
                "container_configuration": {"image": "acr.example/digibuddy:new"},
                "protocols": [{"protocol": "responses", "version": "2.0.0"}],
            },
            {
                "id": "wrong-kind",
                "created_at": "2026-08-23T12:00:00Z",
                "kind": "managed",
                "status": "active",
                "container_configuration": {"image": "acr.example/digibuddy:wrong"},
                "protocols": [{"protocol": "responses", "version": "2.0.0"}],
            },
        ]

        selected = select_source_version(versions)

        self.assertEqual(selected["id"], "newest-valid")

    def test_select_source_version_rejects_when_no_valid_definition_exists(self) -> None:
        versions = [
            {
                "id": "bad-protocol",
                "created_at": "2026-08-23T10:00:00Z",
                "kind": "hosted",
                "status": "active",
                "container_configuration": {"image": "acr.example/digibuddy:bad"},
                "protocols": [{"protocol": "chat", "version": "1"}],
            }
        ]

        with self.assertRaisesRegex(ValueError, "hosted"):
            select_source_version(versions)


class ExtractOutputTextTests(unittest.TestCase):
    def test_extract_output_text_concatenates_response_content(self) -> None:
        payload = {
            "output": [
                {"content": [{"text": "Hello, "}, {"text": ""}]},
                {"content": [{"text": "world"}, {"type": "input_text"}]},
            ]
        }

        self.assertEqual(extract_output_text(payload), "Hello, world")


class ReleaseReceiptTests(unittest.TestCase):
    def test_release_receipt_contains_release_metadata_without_environment_values(self) -> None:
        release_config = ReleaseConfig()
        receipt = release_receipt(
            config=release_config,
            image_tag="abc1234-20260823T122333Z",
            image_digest="sha256:beefcafe",
            version_id="version-42",
            response_id="response-99",
            released_at=datetime(2026, 8, 23, 12, 23, 33, tzinfo=timezone.utc),
        )

        self.assertEqual(receipt["image_digest"], "sha256:beefcafe")
        self.assertEqual(receipt["version_id"], "version-42")
        self.assertEqual(receipt["response_id"], "response-99")
        self.assertEqual(receipt["image_tag"], "abc1234-20260823T122333Z")
        self.assertNotIn("environment", {key.lower() for key in receipt})
        self.assertNotIn("env", {key.lower() for key in receipt})
        self.assertNotIn("environment_variables", {key.lower() for key in receipt})


if __name__ == "__main__":
    unittest.main()
