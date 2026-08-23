"""Fetch a web page and return it as clean Markdown (Jina Reader, HTTP fallback).

CLI:
    python -m fetch_url <url> [--no-cache] [--timeout 30]
"""

import argparse
import asyncio
from typing import Optional

from pydantic import BaseModel, Field


class WebFetchParams(BaseModel):
    url: str = Field(
        description="The full URL to fetch (e.g. 'https://example.com/article')"
    )
    no_cache: bool = Field(
        default=False,
        description="If true, bypass Jina cache to force a fresh fetch.",
    )
    timeout_seconds: int = Field(
        default=30,
        ge=1,
        le=120,
        description="HTTP timeout in seconds.",
    )


async def fetch_url(params: WebFetchParams) -> str:
    """Fetch the content of a web page and return it as clean Markdown.

    Use this tool when the user shares a URL/link and you need to read its content.
    Works with blogs, news, documentation, articles, and most public web pages.
    Returns the page content in readable Markdown format.
    """

    import re
    import urllib.error
    import urllib.parse
    import urllib.request

    target_url = (params.url or "").strip()
    if not target_url:
        raise ValueError("url is required")

    # Common copy/paste cases: <https://...>, trailing ')', '.', ','
    target_url = target_url.strip("<>")
    while target_url and target_url[-1] in ").,;]":
        target_url = target_url[:-1]
    if not target_url.startswith(("http://", "https://")):
        target_url = "https://" + target_url

    max_chars = 50_000  # prevent context-window overflow

    # ── Primary: Jina Reader API (POST) ──────────────────────────────
    # Use POST to avoid subtle URL parsing issues and support hash routes.
    jina_url = "https://r.jina.ai/"

    def _looks_like_error_page(md: str) -> bool:
        head = (md or "")[:800].lower()
        # Heuristic: when the fetch got a 404/blocked page, Jina often surfaces
        # it in the title/content; if so, try a direct fetch fallback.
        return (
            "title: 404" in head
            or "404 not found" in head
            or "status code: 404" in head
            or "error fetching" in head
        )

    def _jina_post(no_cache: bool) -> str:
        data = urllib.parse.urlencode({"url": target_url}).encode("utf-8")
        req = urllib.request.Request(
            jina_url,
            data=data,
            method="POST",
            headers={
                "Accept": "text/markdown",
                "Content-Type": "application/x-www-form-urlencoded",
                "User-Agent": "Mozilla/5.0 (compatible; AgentBot/1.0)",
                **({"x-no-cache": "true"} if no_cache else {}),
            },
        )
        with urllib.request.urlopen(req, timeout=int(params.timeout_seconds)) as resp:
            return resp.read().decode("utf-8", errors="replace")

    try:
        content = _jina_post(bool(params.no_cache))
        if (not params.no_cache) and _looks_like_error_page(content):
            # Retry once without cache to avoid stale cached error pages.
            content = _jina_post(True)
        if len(content) > max_chars:
            content = content[:max_chars] + "\n\n... (content truncated)"
        if not _looks_like_error_page(content):
            return content
    except Exception:
        pass  # fall through to direct fetch

    # ── Fallback: direct HTTP + basic HTML stripping ─────────────────
    try:
        req = urllib.request.Request(
            target_url,
            headers={
                "User-Agent": (
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/125.0.0.0 Safari/537.36"
                ),
            },
        )
        with urllib.request.urlopen(req, timeout=int(params.timeout_seconds)) as resp:
            raw = resp.read().decode("utf-8", errors="replace")

        # Strip scripts, styles, comments, then tags
        text = re.sub(r"<script[^>]*>.*?</script>", "", raw, flags=re.S)
        text = re.sub(r"<style[^>]*>.*?</style>", "", text, flags=re.S)
        text = re.sub(r"<!--.*?-->", "", text, flags=re.S)
        text = re.sub(r"<br\s*/?>", "\n", text, flags=re.I)
        text = re.sub(r"</(p|div|tr|li|h[1-6])>", "\n", text, flags=re.I)
        text = re.sub(r"<[^>]+>", " ", text)
        # Decode common entities
        text = (
            text.replace("&nbsp;", " ")
            .replace("&amp;", "&")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", '"')
        )
        text = re.sub(r"[ \t]+", " ", text)
        text = re.sub(r"\n{3,}", "\n\n", text)
        text = text.strip()

        if len(text) > max_chars:
            text = text[:max_chars] + "\n\n... (content truncated)"
        return text if text else "Page fetched but no readable content could be extracted."

    except urllib.error.HTTPError as e:
        return f"Error fetching URL: HTTP {e.code} {e.reason}"
    except Exception as e:
        return f"Error fetching URL: {e}"


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="fetch_url", description=__doc__)
    parser.add_argument("url")
    parser.add_argument("--no-cache", action="store_true", help="Bypass the Jina cache")
    parser.add_argument("--timeout", type=int, default=30, help="HTTP timeout in seconds")

    args = parser.parse_args(argv)
    print(
        asyncio.run(
            fetch_url(
                WebFetchParams(
                    url=args.url,
                    no_cache=args.no_cache,
                    timeout_seconds=args.timeout,
                )
            )
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
