"""
Create a standards-compliant .eml file from HTML content.

Generates a MIME email (RFC 5322) that Outlook, Thunderbird, Apple Mail,
and all major email clients can open natively.  Uses only the Python
standard library — zero external dependencies.

Usage (from agent-generated code):

    import sys, os
    sys.path.insert(0, os.path.join(os.environ.get("AGENT_SKILLS_DIR",
        "/home/site/wwwroot/.github/skills"), "marketing-email", "scripts"))
    from create_eml import create_eml

    path = create_eml(
        html_path="/tmp/campaign.html",
        subject="Azure AI 最新动态 | Latest Updates",
        output_path="/tmp/campaign.eml",
        sender="noreply@microsoft.com",
        to="all-hands@microsoft.com",
    )
    print(f"Email saved to {path}")

Or directly from an HTML string:

    path = create_eml(
        html="<html><body><h1>Hello</h1></body></html>",
        subject="Test Email",
        output_path="/tmp/test.eml",
    )
"""

import os
import sys
from datetime import datetime, timezone
from email import policy
from email.headerregistry import Address
from email.message import EmailMessage
from email.utils import format_datetime


def create_eml(
    *,
    html: str | None = None,
    html_path: str | None = None,
    subject: str = "(No Subject)",
    output_path: str | None = None,
    sender: str = "noreply@microsoft.com",
    to: str = "recipients@microsoft.com",
    importance: str | None = None,
    date: datetime | None = None,
) -> str:
    """Create an .eml file from HTML content.

    Parameters
    ----------
    html : str, optional
        Raw HTML string to use as the email body.
    html_path : str, optional
        Path to an .html file.  Read and used as the body.
        One of ``html`` or ``html_path`` must be provided.
    subject : str
        Email subject line (supports CJK / Unicode).
    output_path : str, optional
        Where to write the .eml file.  Defaults to ``/tmp/<subject>.eml``
        (sanitised).
    sender : str
        From address shown in the email header.
    to : str
        To address shown in the email header.
    importance : str, optional
        ``"high"``, ``"normal"``, or ``"low"``.  Sets the
        ``Importance`` and ``X-Priority`` headers (Outlook reads these).
    date : datetime, optional
        Date/time for the ``Date`` header.  Defaults to now (UTC).

    Returns
    -------
    str
        Absolute path of the written .eml file.
    """
    # ── Resolve HTML body ────────────────────────────────────────────
    if html is None and html_path is None:
        raise ValueError("Provide either 'html' or 'html_path'.")
    if html is None:
        with open(html_path, "r", encoding="utf-8") as f:
            html = f.read()

    # ── Build MIME message ───────────────────────────────────────────
    msg = EmailMessage(policy=policy.SMTP)
    msg["Subject"] = subject
    msg["From"] = sender
    msg["To"] = to
    msg["Date"] = format_datetime(date or datetime.now(timezone.utc))
    msg["MIME-Version"] = "1.0"

    # Importance / priority (Outlook honours these)
    if importance:
        level = importance.lower()
        msg["Importance"] = level.capitalize()      # Normal / High / Low
        msg["X-Priority"] = {"high": "1", "normal": "3", "low": "5"}.get(
            level, "3"
        )

    # Set HTML body with UTF-8 encoding (critical for CJK)
    msg.set_content(
        _strip_html_to_text(html),
        subtype="plain",
        charset="utf-8",
    )
    msg.add_alternative(html, subtype="html", charset="utf-8")

    # ── Determine output path ────────────────────────────────────────
    if output_path is None:
        safe_name = _sanitise_filename(subject)
        output_path = f"/tmp/{safe_name}.eml"

    # Ensure parent directory exists
    os.makedirs(os.path.dirname(output_path) or "/tmp", exist_ok=True)

    # ── Write .eml ───────────────────────────────────────────────────
    with open(output_path, "wb") as f:
        f.write(msg.as_bytes())

    return os.path.abspath(output_path)


# ── Helpers ──────────────────────────────────────────────────────────────


def _sanitise_filename(name: str, max_len: int = 80) -> str:
    """Turn a subject line into a safe filename (no extension)."""
    import re

    # Replace anything that's not alphanumeric, CJK, hyphen, or underscore
    safe = re.sub(r"[^\w\u4e00-\u9fff\u3400-\u4dbf\-]", "_", name)
    # Collapse runs of underscores
    safe = re.sub(r"_+", "_", safe).strip("_")
    return safe[:max_len] or "email"


def _strip_html_to_text(html: str) -> str:
    """Naive HTML → plain-text fallback for the text/plain MIME part."""
    import re

    text = re.sub(r"<style[^>]*>.*?</style>", "", html, flags=re.S)
    text = re.sub(r"<script[^>]*>.*?</script>", "", text, flags=re.S)
    text = re.sub(r"<!--.*?-->", "", text, flags=re.S)
    text = re.sub(r"<br\s*/?>", "\n", text, flags=re.I)
    text = re.sub(r"</(p|div|tr|li|h[1-6])>", "\n", text, flags=re.I)
    text = re.sub(r"<[^>]+>", "", text)
    # Decode common HTML entities
    text = (
        text.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&bull;", "- ")
        .replace("&mdash;", "—")
        .replace("&ndash;", "–")
        .replace("&quot;", '"')
        .replace("&#39;", "'")
    )
    # Collapse blank lines
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


# ── CLI entry point ──────────────────────────────────────────────────────

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(
            "Usage: python create_eml.py <html_file> <subject> "
            "[output.eml] [from] [to]"
        )
        sys.exit(1)

    path = create_eml(
        html_path=sys.argv[1],
        subject=sys.argv[2],
        output_path=sys.argv[3] if len(sys.argv) > 3 else None,
        sender=sys.argv[4] if len(sys.argv) > 4 else "noreply@microsoft.com",
        to=sys.argv[5] if len(sys.argv) > 5 else "recipients@microsoft.com",
    )
    print(f"Created: {path}")
