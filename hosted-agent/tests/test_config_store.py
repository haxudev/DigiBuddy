import json
import sys
import tempfile
from types import ModuleType
from urllib import error as urllib_error
import unittest
from unittest import mock
from pathlib import Path

from codex_adapter import config_store
from codex_adapter.config_store import (
    BLOB_ARTIFACT_UPLOAD_ATTEMPTS,
    BLOB_ARTIFACT_UPLOAD_INITIAL_BACKOFF_SECONDS,
    BlobConfigStore,
    CONFIG_API_ENV,
    CONFIG_API_SECRET_ENV,
    CONFIG_API_SCOPE_ENV,
    CONFIG_DIR_ENV,
    CONFIG_URI_ENV,
    SCHEMA_VERSION,
    CachingConfigStore,
    FileConfigStore,
    HttpConfigStore,
    NullConfigStore,
    artifact_path,
    build_config_store,
)


class FakeAzureError(Exception):
    pass


class FakeContentSettings:
    def __init__(self, *, content_type):
        self.content_type = content_type


class FakeContainer:
    def __init__(self, failures):
        self.failures = list(failures)
        self.calls = []

    def upload_blob(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        if self.failures:
            raise self.failures.pop(0)


class FakeAccessToken:
    def __init__(self, token="fake-token", expires_on=4_102_444_800):
        self.token = token
        self.expires_on = expires_on


class FakeCredential:
    def __init__(self):
        self.calls = []

    def get_token(self, scope):
        self.calls.append(scope)
        return FakeAccessToken()


class FakeResponse:
    def __init__(self, body):
        self._body = body
        self.closed = False

    def read(self):
        return self._body

    def close(self):
        self.closed = True


class FakeOpener:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def open(self, request, timeout):
        self.calls.append((request, timeout))
        response = self.responses.pop(0)
        if isinstance(response, BaseException):
            raise response
        return FakeResponse(response)


def fake_azure_modules():
    azure = ModuleType("azure")
    azure_core = ModuleType("azure.core")
    azure_core_exceptions = ModuleType("azure.core.exceptions")
    azure_core_exceptions.AzureError = FakeAzureError
    azure_storage = ModuleType("azure.storage")
    azure_storage_blob = ModuleType("azure.storage.blob")
    azure_storage_blob.ContentSettings = FakeContentSettings
    return {
        "azure": azure,
        "azure.core": azure_core,
        "azure.core.exceptions": azure_core_exceptions,
        "azure.storage": azure_storage,
        "azure.storage.blob": azure_storage_blob,
    }


def blob_store(container):
    store = BlobConfigStore.__new__(BlobConfigStore)
    store._container = container
    return store


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


class BlobConfigStoreTests(unittest.TestCase):
    def test_write_artifact_retries_after_a_transient_failure(self):
        container = FakeContainer(
            [
                FakeAzureError(
                    "Transient failure at "
                    "https://account.blob.core.windows.net/container/blob"
                    "?sig=secret&se=soon"
                )
            ]
        )
        store = blob_store(container)

        with mock.patch.dict(sys.modules, fake_azure_modules()):
            with mock.patch.object(config_store.time, "sleep") as sleep:
                with self.assertLogs("codex_adapter.config_store", level="WARNING") as logs:
                    result = store.write_artifact(
                        "a" * 32, "report.md", b"hello", "text/markdown"
                    )

        self.assertTrue(result)
        self.assertEqual(len(container.calls), 2)
        sleep.assert_called_once_with(BLOB_ARTIFACT_UPLOAD_INITIAL_BACKOFF_SECONDS)
        log_output = "\n".join(logs.output)
        self.assertIn("FakeAzureError", log_output)
        self.assertIn("Transient failure", log_output)
        self.assertIn("https://account.blob.core.windows.net/container/blob", log_output)
        self.assertNotIn("?sig", log_output)
        self.assertNotIn("secret", log_output)
        _, kwargs = container.calls[-1]
        self.assertEqual(kwargs["content_settings"].content_type, "text/markdown")

    def test_write_artifact_returns_false_after_exhausting_retries(self):
        container = FakeContainer(
            [
                FakeAzureError("still blocked token=secret"),
                FakeAzureError("still blocked token=secret"),
                FakeAzureError("still blocked token=secret"),
            ]
        )
        store = blob_store(container)

        with mock.patch.dict(sys.modules, fake_azure_modules()):
            with mock.patch.object(config_store.time, "sleep") as sleep:
                with self.assertLogs("codex_adapter.config_store", level="WARNING") as logs:
                    result = store.write_artifact(
                        "a" * 32, "report.md", b"hello", "text/markdown"
                    )

        self.assertFalse(result)
        self.assertEqual(len(container.calls), BLOB_ARTIFACT_UPLOAD_ATTEMPTS)
        self.assertEqual(
            sleep.mock_calls,
            [
                mock.call(BLOB_ARTIFACT_UPLOAD_INITIAL_BACKOFF_SECONDS),
                mock.call(BLOB_ARTIFACT_UPLOAD_INITIAL_BACKOFF_SECONDS * 2),
            ],
        )
        self.assertEqual(len(logs.output), BLOB_ARTIFACT_UPLOAD_ATTEMPTS)
        self.assertNotIn("secret", "\n".join(logs.output))


class HttpConfigStoreTests(unittest.TestCase):
    def store(self, responses):
        credential = FakeCredential()
        opener = FakeOpener(responses)
        store = HttpConfigStore(
            "https://console.example/api/runtime/",
            "api://digibuddy/.default",
            credential=credential,
            opener=opener,
            timeout_seconds=1.25,
        )
        return store, credential, opener

    def test_read_hit_returns_document(self):
        store, credential, opener = self.store([b'{"model":"gpt-5.6"}'])

        self.assertEqual(store.read("models.json"), {"model": "gpt-5.6"})

        request, timeout = opener.calls[0]
        self.assertEqual(
            request.full_url,
            "https://console.example/api/runtime/documents/models.json",
        )
        self.assertEqual(request.get_method(), "GET")
        self.assertEqual(request.get_header("Authorization"), "Bearer fake-token")
        self.assertEqual(timeout, 1.25)
        self.assertEqual(credential.calls, ["api://digibuddy/.default"])

    def test_secret_auth_sends_bearer_header_without_credential(self):
        secret = "s" * 32
        credential = FakeCredential()
        opener = FakeOpener([b'{"model":"gpt-5.6"}'])
        store = HttpConfigStore(
            "https://console.example/api/runtime/",
            "",
            secret=secret,
            credential=credential,
            opener=opener,
            timeout_seconds=1.25,
        )

        self.assertEqual(store.read("models.json"), {"model": "gpt-5.6"})

        request, _ = opener.calls[0]
        self.assertEqual(request.get_header("Authorization"), f"Bearer {secret}")
        self.assertEqual(credential.calls, [])

    def test_unset_secret_keeps_managed_identity_path(self):
        store, credential, opener = self.store([b'{"model":"gpt-5.6"}'])

        self.assertEqual(store.read("models.json"), {"model": "gpt-5.6"})

        request, _ = opener.calls[0]
        self.assertEqual(request.get_header("Authorization"), "Bearer fake-token")
        self.assertEqual(credential.calls, ["api://digibuddy/.default"])

    def test_shared_secret_is_redacted_from_logs(self):
        secret = "sensitive-value-" + ("x" * 32)
        store = HttpConfigStore(
            "https://console.example/api/runtime/",
            "",
            secret=secret,
            credential=FakeCredential(),
            opener=FakeOpener(
                [
                    urllib_error.URLError(
                        f"blocked Authorization: Bearer {secret} "
                        f"at https://x.test/a?token={secret}"
                    )
                ]
            ),
        )

        with self.assertLogs("codex_adapter.config_store", level="WARNING") as logs:
            self.assertIsNone(store.read("models.json"))

        output = "\n".join(logs.output)
        self.assertNotIn(secret, output)
        self.assertIn("Bearer <redacted>", output)

    def test_read_404_returns_none(self):
        not_found = urllib_error.HTTPError(
            "https://console.example/api/runtime/documents/models.json",
            404,
            "not found",
            hdrs=None,
            fp=None,
        )
        store, _, _ = self.store([not_found])

        self.assertIsNone(store.read("models.json"))

    def test_unreachable_console_returns_none(self):
        store, _, _ = self.store(
            [urllib_error.URLError("blocked token=secret at https://x.test/a?sig=s")]
        )

        with self.assertLogs("codex_adapter.config_store", level="WARNING") as logs:
            self.assertIsNone(store.read("models.json"))

        output = "\n".join(logs.output)
        self.assertIn("Config API read failed", output)
        self.assertNotIn("secret", output)
        self.assertNotIn("?sig", output)

    def test_write_artifact_success_returns_true(self):
        store, _, opener = self.store([b""])
        artifact, owner = "a" * 32, "b" * 32

        self.assertTrue(
            store.write_artifact(artifact, "报告.md", b"# report", "text/markdown", owner)
        )

        request, _ = opener.calls[0]
        self.assertEqual(request.get_method(), "PUT")
        self.assertEqual(
            request.full_url,
            "https://console.example/api/runtime/artifacts/"
            f"{owner}/{artifact}/%E6%8A%A5%E5%91%8A.md",
        )
        self.assertEqual(request.data, b"# report")
        self.assertEqual(request.get_header("Content-type"), "text/markdown")

    def test_write_artifact_failure_returns_false(self):
        failure = urllib_error.HTTPError(
            "https://console.example/api/runtime/artifacts/x?token=secret",
            500,
            "failed",
            hdrs=None,
            fp=None,
        )
        store, _, _ = self.store([failure])

        with self.assertLogs("codex_adapter.config_store", level="WARNING") as logs:
            self.assertFalse(
                store.write_artifact(
                    "a" * 32, "report.md", b"hello", "text/markdown", "b" * 32
                )
            )

        self.assertNotIn("secret", "\n".join(logs.output))

    def test_token_is_reused_across_calls(self):
        store, credential, _ = self.store([b'{"model":"a"}', b'{"profiles":[]}'])

        self.assertEqual(store.read("models.json"), {"model": "a"})
        self.assertEqual(store.read("profiles.json"), {"profiles": []})

        self.assertEqual(credential.calls, ["api://digibuddy/.default"])


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

    def test_directory_configuration_takes_precedence(self):
        with mock.patch.object(config_store, "HttpConfigStore") as http_store:
            store = build_config_store(
                {
                    CONFIG_DIR_ENV: ".",
                    CONFIG_API_ENV: "https://console.example/api/runtime",
                    CONFIG_API_SCOPE_ENV: "api://digibuddy/.default",
                    CONFIG_URI_ENV: "https://storage.example/container",
                }
            )

        self.assertIsInstance(store, CachingConfigStore)
        self.assertIsInstance(store._inner, FileConfigStore)
        http_store.assert_not_called()

    def test_config_api_takes_precedence_over_blob(self):
        with mock.patch.object(
            config_store, "HttpConfigStore", return_value=NullConfigStore()
        ) as http_store:
            store = build_config_store(
                {
                    CONFIG_API_ENV: "https://console.example/api/runtime",
                    CONFIG_API_SCOPE_ENV: "api://digibuddy/.default",
                    CONFIG_URI_ENV: "https://storage.example/container",
                }
            )

        self.assertIsInstance(store, CachingConfigStore)
        self.assertIsInstance(store._inner, NullConfigStore)
        http_store.assert_called_once_with(
            "https://console.example/api/runtime",
            "api://digibuddy/.default",
            secret="",
        )

    def test_config_api_secret_is_passed_without_scope(self):
        secret = "s" * 32
        with mock.patch.object(
            config_store, "HttpConfigStore", return_value=NullConfigStore()
        ) as http_store:
            store = build_config_store(
                {
                    CONFIG_API_ENV: "https://console.example/api/runtime",
                    CONFIG_API_SECRET_ENV: secret,
                }
            )

        self.assertIsInstance(store, CachingConfigStore)
        self.assertIsInstance(store._inner, NullConfigStore)
        http_store.assert_called_once_with(
            "https://console.example/api/runtime",
            "",
            secret=secret,
        )

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


class HttpConfigStoreRedirectTests(unittest.TestCase):
    """A redirect must never carry the managed-identity token to another host."""

    def test_the_default_opener_refuses_to_follow_a_redirect(self):
        from codex_adapter.config_store import HttpConfigStore

        store = HttpConfigStore("https://console.example/api/runtime", "api://scope/.default")
        handlers = [type(h).__name__ for h in store._opener.handlers]
        self.assertIn("_NoRedirects", handlers)
        self.assertNotIn("HTTPRedirectHandler", handlers)

    def test_the_handler_declines_every_redirect(self):
        from codex_adapter.config_store import _NoRedirects

        self.assertIsNone(
            _NoRedirects().redirect_request(
                None, None, 302, "Found", {}, "https://elsewhere.example/"
            )
        )
