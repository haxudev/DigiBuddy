"""SharePoint and OneDrive access through Microsoft Graph.

Resolves a SharePoint/OneDrive sharing link to its `driveItem` and downloads the
content. Two authentication modes are supported:

  - **app-only** (default): client credentials for the agent's own Entra ID
    application. Use this when the agent acts on its own behalf.
  - **on-behalf-of**: set ``DIGIBUDDY_GRAPH_USER_ASSERTION`` to a user access
    token so Graph applies that user's SharePoint permissions instead.

Environment:
  - ``DIGIBUDDY_GRAPH_TENANT_ID``      (required)
  - ``DIGIBUDDY_GRAPH_CLIENT_ID``      (required)
  - ``DIGIBUDDY_GRAPH_CLIENT_SECRET``  (required)
  - ``DIGIBUDDY_GRAPH_SCOPES``         (optional) comma separated, defaults to
    ``https://graph.microsoft.com/.default``
  - ``DIGIBUDDY_GRAPH_USER_ASSERTION`` (optional) enables the on-behalf-of flow
  - ``DIGIBUDDY_GRAPH_AUTHORITY_HOST`` (optional) defaults to
    ``https://login.microsoftonline.com``

Requires: msal >= 1.30.0, aiohttp >= 3.9.0

CLI:
    python -m sharepoint download <share-url> --out <path>
"""

import argparse
import asyncio
import base64
import logging
import os
import sys
from pathlib import Path
from typing import Any, Optional

import aiohttp

_GRAPH_SCOPE_DEFAULT = "https://graph.microsoft.com/.default"
_GRAPH_API_ROOT = "https://graph.microsoft.com/v1.0"


def _build_share_id(share_url: str) -> str:
    # Graph shares API uses: u! + base64url(share_url) with no '=' padding.
    encoded = base64.urlsafe_b64encode(share_url.encode("utf-8")).decode("utf-8")
    return f"u!{encoded.rstrip('=')}"


def acquire_graph_token(user_assertion: Optional[str] = None) -> Optional[str]:
    """Acquire a Microsoft Graph token, on-behalf-of a user when one is given."""
    client_id = (os.environ.get("DIGIBUDDY_GRAPH_CLIENT_ID") or "").strip()
    client_secret = (os.environ.get("DIGIBUDDY_GRAPH_CLIENT_SECRET") or "").strip()
    tenant_id = (os.environ.get("DIGIBUDDY_GRAPH_TENANT_ID") or "").strip()
    authority_host = (
        os.environ.get("DIGIBUDDY_GRAPH_AUTHORITY_HOST")
        or "https://login.microsoftonline.com"
    ).strip().rstrip("/")
    scopes_env = (os.environ.get("DIGIBUDDY_GRAPH_SCOPES") or "").strip()

    if not client_id or not client_secret or not tenant_id:
        logging.warning(
            "[Graph] DIGIBUDDY_GRAPH_TENANT_ID, _CLIENT_ID and _CLIENT_SECRET are required"
        )
        return None

    scopes = [s.strip() for s in scopes_env.split(",") if s.strip()] or [_GRAPH_SCOPE_DEFAULT]

    try:
        import msal
    except ImportError:
        logging.warning("[Graph] msal is not installed; cannot acquire a token")
        return None

    app = msal.ConfidentialClientApplication(
        client_id=client_id,
        authority=f"{authority_host}/{tenant_id}",
        client_credential=client_secret,
    )
    if user_assertion:
        result = app.acquire_token_on_behalf_of(user_assertion=user_assertion, scopes=scopes)
    else:
        result = app.acquire_token_for_client(scopes=scopes)

    access_token = (result or {}).get("access_token")
    if access_token:
        return str(access_token)

    logging.warning(
        "[Graph] token acquisition failed: %s",
        (result or {}).get("error_description") or (result or {}).get("error") or "unknown",
    )
    return None


async def download_shared_link(
    share_url: str,
    *,
    user_assertion: Optional[str] = None,
) -> Optional[dict[str, Any]]:
    """Download a SharePoint/OneDrive shared link through Microsoft Graph.

    Returns ``{"data", "content_type", "filename"}`` or None when the link
    cannot be resolved with the configured identity.
    """
    assertion = user_assertion or (os.environ.get("DIGIBUDDY_GRAPH_USER_ASSERTION") or "").strip()
    graph_token = acquire_graph_token(assertion or None)
    if not graph_token:
        return None

    share_id = _build_share_id(share_url)
    meta_url = f"{_GRAPH_API_ROOT}/shares/{share_id}/driveItem"
    content_url = f"{_GRAPH_API_ROOT}/shares/{share_id}/driveItem/content"

    headers = {"Authorization": f"Bearer {graph_token}"}
    timeout = aiohttp.ClientTimeout(total=45)

    try:
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(meta_url, headers=headers) as meta_resp:
                if meta_resp.status >= 400:
                    detail = await meta_resp.text()
                    logging.warning(
                        "[Graph] driveItem metadata request failed (%s): %s",
                        meta_resp.status,
                        detail[:300],
                    )
                    return None
                metadata = await meta_resp.json()

            file_name = (metadata or {}).get("name") or "shared-document"
            mime_type = ((metadata or {}).get("file") or {}).get(
                "mimeType"
            ) or "application/octet-stream"

            async with session.get(content_url, headers=headers) as content_resp:
                if content_resp.status == 200:
                    return {
                        "data": await content_resp.read(),
                        "content_type": mime_type,
                        "filename": file_name,
                    }
                detail = await content_resp.text()
                logging.warning(
                    "[Graph] driveItem/content request failed (%s): %s",
                    content_resp.status,
                    detail[:300],
                )
    except aiohttp.ClientError as exc:
        logging.warning("[Graph] share link download failed: %s", exc)

    return None


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="sharepoint", description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    download = subparsers.add_parser("download", help="Download a SharePoint/OneDrive share link")
    download.add_argument("share_url")
    download.add_argument("--out", default=None, help="Output directory (default: current dir)")

    args = parser.parse_args(argv)
    result = asyncio.run(download_shared_link(args.share_url))
    if not result:
        print(
            "Download failed. Check the DIGIBUDDY_GRAPH_* settings and link permissions.",
            file=sys.stderr,
        )
        return 1

    target = Path(args.out or ".") / result["filename"]
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(result["data"])
    print(target)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
