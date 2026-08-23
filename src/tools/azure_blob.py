"""Azure Blob Storage delivery for DigiBuddy agent artifacts.

The agent runs inside a Foundry session sandbox with no public HTTP surface of
its own, so files that must be shared with a user (email attachments that are
too large or of a restricted type, generated reports, and so on) are uploaded to
a Blob container and handed back as time-limited user-delegation SAS URLs.

Authentication uses the session's Entra ID identity, so the only role needed is
``Storage Blob Data Contributor`` on the target container.

Environment:
  - ``DIGIBUDDY_BLOB_SERVICE_URI``    (required) e.g. https://acct.blob.core.windows.net
  - ``DIGIBUDDY_BLOB_CONTAINER``      (optional) defaults to ``agent-files``
  - ``DIGIBUDDY_BLOB_LINK_TTL_HOURS`` (optional) defaults to ``24``
  - ``AZURE_CLIENT_ID``               (optional) user-assigned managed identity

Requires: azure-identity >= 1.17.0, azure-storage-blob >= 12.19.0

CLI:
    python -m azure_blob upload <path> [--prefix PREFIX]
"""

import argparse
import logging
import mimetypes
import os
import re
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

DEFAULT_CONTAINER = "agent-files"
DEFAULT_LINK_TTL_HOURS = 24

_blob_service_client = None


def _container_name() -> str:
    return (os.environ.get("DIGIBUDDY_BLOB_CONTAINER") or DEFAULT_CONTAINER).strip()


def _link_ttl() -> timedelta:
    raw = (os.environ.get("DIGIBUDDY_BLOB_LINK_TTL_HOURS") or "").strip()
    try:
        hours = int(raw) if raw else DEFAULT_LINK_TTL_HOURS
    except ValueError:
        hours = DEFAULT_LINK_TTL_HOURS
    return timedelta(hours=max(1, hours))


def _get_blob_service_client():
    """Get or create a BlobServiceClient using the session's Entra ID identity."""
    global _blob_service_client
    if _blob_service_client is not None:
        return _blob_service_client

    blob_uri = (os.environ.get("DIGIBUDDY_BLOB_SERVICE_URI") or "").strip()
    if not blob_uri:
        logging.warning("[AzureBlob] DIGIBUDDY_BLOB_SERVICE_URI is not configured")
        return None

    client_id = (os.environ.get("AZURE_CLIENT_ID") or "").strip()
    try:
        from azure.identity import DefaultAzureCredential, ManagedIdentityCredential
        from azure.storage.blob import BlobServiceClient

        credential = (
            ManagedIdentityCredential(client_id=client_id)
            if client_id
            else DefaultAzureCredential()
        )
        _blob_service_client = BlobServiceClient(account_url=blob_uri, credential=credential)
        return _blob_service_client
    except Exception as exc:
        logging.error("[AzureBlob] Failed to create BlobServiceClient: %s", exc)
        return None


def _ensure_container(client) -> bool:
    """Create the delivery container if it does not already exist."""
    name = _container_name()
    try:
        container = client.get_container_client(name)
        if not container.exists():
            container.create_container()
            logging.info("[AzureBlob] Created container '%s'", name)
        return True
    except Exception as exc:
        logging.error("[AzureBlob] Failed to ensure container '%s': %s", name, exc)
        return False


def _slugify_ascii(value: str) -> str:
    raw = (value or "").strip()
    if not raw:
        return ""
    raw = raw.encode("ascii", errors="ignore").decode("ascii")
    return re.sub(r"[^A-Za-z0-9._-]+", "_", raw).strip("._-")


def _generate_download_url(client, blob_name: str, filename: str) -> Optional[str]:
    """Build a read-only user-delegation SAS URL for a blob.

    A user-delegation SAS is signed with an Entra ID key rather than the account
    key, so no storage account secret is ever needed or stored.
    """
    from urllib.parse import quote

    from azure.storage.blob import BlobSasPermissions, generate_blob_sas

    now = datetime.now(timezone.utc)
    expiry = now + _link_ttl()
    try:
        delegation_key = client.get_user_delegation_key(
            key_start_time=now - timedelta(minutes=5),
            key_expiry_time=expiry,
        )
        token = generate_blob_sas(
            account_name=client.account_name,
            container_name=_container_name(),
            blob_name=blob_name,
            user_delegation_key=delegation_key,
            permission=BlobSasPermissions(read=True),
            expiry=expiry,
            content_disposition=f'attachment; filename="{_slugify_ascii(filename) or "download"}"',
        )
    except Exception as exc:
        logging.error("[AzureBlob] Failed to sign download URL for %s: %s", blob_name, exc)
        return None

    return f"{client.url.rstrip('/')}/{_container_name()}/{quote(blob_name, safe='/')}?{token}"


def upload_single_file(filepath: str, blob_prefix: Optional[str] = None) -> Optional[str]:
    """Upload one file to Blob Storage and return a time-limited download URL.

    Returns None when storage is not configured or the upload fails; callers are
    expected to surface that to the user rather than silently dropping the file.
    """
    path = Path(filepath)
    if not path.is_file():
        logging.warning("[AzureBlob] upload_single_file: file not found: %s", filepath)
        return None

    client = _get_blob_service_client()
    if not client or not _ensure_container(client):
        return None

    from azure.storage.blob import ContentSettings

    prefix = blob_prefix or uuid.uuid4().hex[:12]
    safe_stem = _slugify_ascii(path.stem) or "file"
    blob_name = f"{prefix}/{safe_stem}_{uuid.uuid4().hex[:8]}{path.suffix}"
    content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"

    try:
        blob_client = client.get_blob_client(_container_name(), blob_name)
        with open(filepath, "rb") as handle:
            blob_client.upload_blob(
                handle,
                overwrite=True,
                content_settings=ContentSettings(content_type=content_type),
            )
    except Exception as exc:
        logging.error("[AzureBlob] upload failed for %s: %s", filepath, exc)
        return None

    logging.info("[AzureBlob] uploaded %s -> %s", filepath, blob_name)
    return _generate_download_url(client, blob_name, path.name)


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="azure_blob", description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    upload = subparsers.add_parser("upload", help="Upload a file and print its download URL")
    upload.add_argument("path")
    upload.add_argument("--prefix", default=None, help="Blob name prefix (default: random)")

    args = parser.parse_args(argv)
    url = upload_single_file(args.path, args.prefix)
    if not url:
        print(
            "Upload failed. Check DIGIBUDDY_BLOB_SERVICE_URI and identity permissions.",
            file=sys.stderr,
        )
        return 1
    print(url)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
