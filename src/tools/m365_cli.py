"""Microsoft 365 access (mail, calendar, OneDrive, SharePoint) via the m365 CLI.

Wraps the vendored ``m365-cli`` npm package and adds email conveniences on top of
``mail send``: reading the body from a file, expanding ``$(cat ...)`` references,
and staging non-plain-text attachments to Azure Blob Storage as download links.

CLI:
    python -m m365_cli 'mail list --top 5 --json'
"""

import argparse
import asyncio
import json
import logging
import os
import re
import shlex
import shutil
import time
from pathlib import Path
from typing import Optional

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Constants for email pre-processing
# ---------------------------------------------------------------------------

# Only plain-text file types are safe to send as direct email attachments.
# ALL binary files (pdf, images, office docs, archives, etc.) are uploaded
# to Azure Blob Storage with download links injected into the email body.
_ALLOWED_ATTACH_EXTENSIONS = frozenset({
    ".txt", ".md", ".csv", ".log",
})

_MAIL_SEND_PREPROCESS_RETRY_COUNT = 1
_MAIL_SEND_PREPROCESS_RETRY_DELAY_SECONDS = 1.0

# Pattern to match $(cat /abs/path) shell substitution in args
_CAT_SUBST_RE = re.compile(r'\$\(cat\s+(/[^\s)]+)\)')


class M365CliParams(BaseModel):
    command: str = Field(
        description=(
            "The m365 CLI sub-command to execute (everything after 'm365'). "
            "Examples: 'mail list --top 5 --json', 'mail send \"user@example.com\" \"Subject\" \"Body\" --json', "
            "'mail read <id> --json', 'calendar list --days 7 --json', "
            "'onedrive ls --json', 'sharepoint sites --json'. "
            "Always append --json for structured output.\n\n"
            "For sending emails with HTML body from a file, use --bodyFile:\n"
            "  mail send \"user@example.com\" \"Subject\" --bodyFile /workspace/body.html --json\n\n"
            "Attachments that are not plain text (pdf, images, office docs, etc.) are "
            "automatically uploaded to Azure Blob Storage and replaced with download "
            "links in the email body. Only .txt/.md/.csv/.log files are sent as direct attachments."
        )
    )
    timeout_seconds: int = Field(
        default=60,
        ge=5,
        le=300,
        description="Command timeout in seconds.",
    )


def _expand_cat_substitutions(args: list[str]) -> list[str]:
    """Expand $(cat /abs/path) shell patterns by reading the referenced files.

    Only absolute paths are expanded. If the file cannot be read, the original
    pattern is left intact (the CLI will receive the literal text).
    """
    def _replace_in_arg(arg: str) -> str:
        def _read(match):
            filepath = match.group(1)
            try:
                content = Path(filepath).read_text(encoding="utf-8")
                logging.info("[m365_cli] Expanded $(cat %s) — %d chars", filepath, len(content))
                return content
            except Exception as exc:
                logging.warning("[m365_cli] Could not read %s for $(cat) expansion: %s", filepath, exc)
                return match.group(0)
        return _CAT_SUBST_RE.sub(_read, arg)

    return [_replace_in_arg(a) for a in args]


def _process_bodyfile_flag(args: list[str]) -> list[str]:
    """Handle custom --bodyFile <path> flag for mail send.

    Reads the file content and inserts it as the body positional argument,
    replacing any existing body. The --bodyFile flag is removed from args.
    """
    bodyfile_idx = None
    for i, a in enumerate(args):
        if a.lower() == "--bodyfile" and i + 1 < len(args):
            bodyfile_idx = i
            break

    if bodyfile_idx is None:
        return args

    filepath = args[bodyfile_idx + 1]
    if not filepath.startswith("/"):
        raise ValueError(f"--bodyFile path must be absolute, got: {filepath}")

    try:
        body_content = Path(filepath).read_text(encoding="utf-8")
        logging.info("[m365_cli] Read --bodyFile %s — %d chars", filepath, len(body_content))
    except Exception as exc:
        raise ValueError(f"Cannot read --bodyFile '{filepath}': {exc}")

    # Remove --bodyFile and its value
    new_args = args[:bodyfile_idx] + args[bodyfile_idx + 2:]

    # For 'mail send <to> <subject> [body]', insert body as 3rd positional
    if len(new_args) >= 2 and new_args[0] == "mail" and new_args[1] == "send":
        # Identify where positionals end and flags begin (after 'mail send')
        first_flag = len(new_args)
        for i in range(2, len(new_args)):
            if new_args[i].startswith("-"):
                first_flag = i
                break

        positionals = new_args[2:first_flag]
        flags = new_args[first_flag:]

        if len(positionals) >= 2:
            # [to, subject] → [to, subject, body_content]
            if len(positionals) >= 3:
                positionals[2] = body_content
            else:
                positionals.append(body_content)
            new_args = ["mail", "send"] + positionals + flags

    return new_args


def _upload_restricted_attachments(args: list[str]) -> tuple[list[str], list[tuple[str, str]]]:
    """Upload restricted attachment types to Azure Blob storage.

    Returns:
        (modified_args, [(filename, download_url), ...])
    """
    # Find --attach or -a flag
    attach_idx = None
    for i, a in enumerate(args):
        if a in ("-a", "--attach"):
            attach_idx = i
            break

    if attach_idx is None:
        return args, []

    # Collect attachment file paths (everything after --attach until next flag)
    attach_end = attach_idx + 1
    while attach_end < len(args) and not args[attach_end].startswith("-"):
        attach_end += 1

    attach_files = args[attach_idx + 1 : attach_end]
    if not attach_files:
        return args, []

    restricted = []
    allowed = []
    for f in attach_files:
        ext = Path(f).suffix.lower()
        if ext in _ALLOWED_ATTACH_EXTENSIONS:
            allowed.append(f)
        else:
            restricted.append(f)

    if not restricted:
        return args, []

    # Upload restricted files to blob
    uploaded: list[tuple[str, str]] = []
    try:
        from azure_blob import upload_single_file
    except ImportError:
        raise RuntimeError(
            "Binary attachments require Blob upload support, but azure_blob is unavailable."
        )

    upload_failures: list[str] = []

    for filepath in restricted:
        try:
            url = upload_single_file(filepath)
            if url:
                uploaded.append((Path(filepath).name, url))
                logging.info("[m365_cli] Uploaded restricted attachment: %s → %s", filepath, url)
            else:
                upload_failures.append(f"{Path(filepath).name} (no download URL returned)")
        except Exception as exc:
            logging.error("[m365_cli] Failed to upload %s: %s", filepath, exc)
            upload_failures.append(f"{Path(filepath).name} ({exc})")

    if upload_failures:
        raise RuntimeError(
            "Binary attachments must be uploaded to Blob links before sending email. "
            f"Upload failed for: {'; '.join(upload_failures)}"
        )

    # Rebuild args: keep only allowed attachments
    before_attach = args[:attach_idx]
    after_attach = args[attach_end:]

    if allowed:
        new_args = before_attach + ["--attach"] + allowed + after_attach
    else:
        new_args = before_attach + after_attach

    return new_args, uploaded


def _build_download_html(uploads: list[tuple[str, str]]) -> str:
    """Build Outlook-compatible HTML download section for blob-hosted attachments.

    Uses table-based layout and 'bulletproof button' technique (bgcolor on <td>)
    so the card renders correctly in desktop Outlook (Word rendering engine).
    """
    if not uploads:
        return ""

    _ICONS = {
        ".pptx": "📊", ".ppt": "📊",
        ".docx": "📝", ".doc": "📝",
        ".xlsx": "📈", ".xls": "📈",
        ".pdf": "📕",
        ".png": "🖼️", ".jpg": "🖼️", ".jpeg": "🖼️", ".gif": "🖼️", ".svg": "🖼️",
        ".zip": "🗜️", ".tar": "🗜️", ".gz": "🗜️", ".7z": "🗜️", ".rar": "🗜️",
        ".mp4": "🎬", ".mov": "🎬", ".webm": "🎬",
        ".html": "🌐", ".eml": "📧",
    }
    _TYPE_LABELS = {
        ".pptx": "PowerPoint", ".ppt": "PowerPoint",
        ".docx": "Word", ".doc": "Word",
        ".xlsx": "Excel", ".xls": "Excel",
        ".pdf": "PDF",
        ".png": "图片", ".jpg": "图片", ".jpeg": "图片", ".gif": "图片", ".svg": "图片",
        ".zip": "压缩包", ".tar": "压缩包", ".gz": "压缩包", ".7z": "压缩包", ".rar": "压缩包",
        ".mp4": "视频", ".mov": "视频", ".webm": "视频",
        ".html": "网页", ".eml": "邮件",
    }

    _FONT = "'Segoe UI',Calibri,Arial,sans-serif"

    rows = ""
    for idx, (filename, url) in enumerate(uploads):
        ext = Path(filename).suffix.lower()
        icon = _ICONS.get(ext, "📄")
        label = _TYPE_LABELS.get(ext, ext.lstrip(".").upper() + " 文件")
        border_css = "border-bottom:1px solid #eaedf0;" if idx < len(uploads) - 1 else ""
        rows += (
            "<tr>"
            # -- icon cell --
            f'<td width="44" valign="middle" '
            f'style="padding:14px 0 14px 18px;{border_css}">'
            f'<span style="font-size:24px;line-height:1;">{icon}</span></td>'
            # -- filename + type label (no forced text color — dark mode inherits) --
            f'<td valign="middle" style="padding:14px 8px;{border_css}">'
            f'<span style="font-size:14px;font-family:{_FONT};'
            f'font-weight:600;">{filename}</span><br>'
            f'<span style="font-size:11px;color:#8a8a8a;font-family:{_FONT};">'
            f'{label}</span></td>'
            # -- download button (bulletproof: bgcolor on <td>) --
            f'<td width="120" align="right" valign="middle" '
            f'style="padding:14px 18px 14px 8px;{border_css}">'
            f'<table cellpadding="0" cellspacing="0" border="0" role="presentation">'
            f"<tr>"
            f'<td align="center" bgcolor="#0078D4" '
            f'style="background-color:#0078D4;border-radius:4px;mso-border-alt:none;">'
            f'<a href="{url}" target="_blank" '
            f"style=\"color:#ffffff;text-decoration:none;font-size:13px;"
            f"font-weight:600;font-family:{_FONT};"
            f'display:inline-block;padding:9px 24px;line-height:18px;">'
            f"\u2B07\uFE0F 下载</a>"
            f"</td></tr></table></td>"
            "</tr>"
        )

    return (
        # Outer wrapper table for margin
        '<table width="100%" cellpadding="0" cellspacing="0" border="0" '
        'role="presentation" style="margin:24px 0;"><tr><td>'
        # Card table with border — no forced colors; Outlook dark mode inverts naturally
        '<table width="100%" cellpadding="0" cellspacing="0" border="0" '
        f'role="presentation" style="border:1px solid #d6dbe0;border-collapse:separate;'
        f'border-spacing:0;border-radius:8px;">'
        # — Header row — uses bgcolor for Outlook compat; dark mode inverts this
        f'<tr><td bgcolor="#F3F5F7" '
        f'style="background-color:#F3F5F7;padding:16px 18px 14px;'
        f'border-bottom:1px solid #d6dbe0;">'
        f'<span style="font-size:15px;font-weight:700;'
        f'font-family:{_FONT};">\U0001F4CE 附件下载</span><br>'
        f'<span style="font-size:12px;color:#8a8a8a;font-family:{_FONT};'
        f'line-height:20px;">'
        f"出于安全策略，以下文件已上传至安全存储，请点击下载。</span>"
        f"</td></tr>"
        # — Body rows —
        f'<tr><td style="padding:0;">'
        f'<table width="100%" cellpadding="0" cellspacing="0" border="0" '
        f'role="presentation">{rows}</table></td></tr>'
        # Close card + wrapper
        "</table></td></tr></table>"
    )


def _unescape_body_literals(args: list[str]) -> list[str]:
    """Convert literal \\n / \\t escape sequences in the body arg to real chars.

    Agents write ``\n`` in command strings which ``shlex.split`` preserves as the
    two-character sequence backslash+n. This helper converts them to actual
    newlines so downstream HTML wrapping and rendering work correctly.
    """
    if len(args) < 5 or args[0] != "mail" or args[1] != "send":
        return args

    body_idx = 4
    if body_idx >= len(args) or args[body_idx].startswith("-"):
        return args

    body = args[body_idx]
    body = body.replace("\\n", "\n").replace("\\t", "\t").replace("\\r", "")
    args = list(args)
    args[body_idx] = body
    return args


def _split_mail_send_args(args: list[str]) -> tuple[Optional[list[str]], Optional[list[str]]]:
    """Split `mail send` arguments into positionals and flags."""
    if len(args) < 2 or args[0] != "mail" or args[1] != "send":
        return None, None

    first_flag = len(args)
    for i in range(2, len(args)):
        if args[i].startswith("-"):
            first_flag = i
            break

    return list(args[2:first_flag]), list(args[first_flag:])


def _inject_download_into_body(args: list[str], download_html: str) -> list[str]:
    """Append download HTML section into the mail send body argument."""
    if not download_html:
        return args

    positionals, flags = _split_mail_send_args(args)
    if positionals is None or flags is None or len(positionals) < 2:
        return args

    body = positionals[2] if len(positionals) >= 3 else ""
    # If body is plain text (no HTML tags), wrap it in theme-adaptive HTML.
    # Do NOT force color/background — let Outlook auto-invert for dark mode.
    if body and not re.search(r"<(?:html|body|div|p|table|h[1-6])\b", body, re.IGNORECASE):
        # Convert newlines → <br>, escape HTML entities
        escaped = body.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        escaped = escaped.replace("\n", "<br>")
        _FONT = "'Segoe UI',Calibri,Arial,sans-serif"
        body = (
            f'<div style="font-family:{_FONT};'
            f'font-size:14px;line-height:1.6;">{escaped}</div>'
        )

    final_body = f"{body}{download_html}" if body else download_html
    rebuilt_positionals = list(positionals)
    if len(rebuilt_positionals) >= 3:
        rebuilt_positionals[2] = final_body
    else:
        rebuilt_positionals.append(final_body)

    return ["mail", "send"] + rebuilt_positionals + flags


def _preprocess_mail_send_with_retry(args: list[str]) -> list[str]:
    """Preprocess `mail send` once, and retry one time if Blob-link staging fails."""
    last_exc: Optional[Exception] = None
    max_attempts = _MAIL_SEND_PREPROCESS_RETRY_COUNT + 1

    for attempt in range(1, max_attempts + 1):
        try:
            return _preprocess_mail_send(list(args))
        except RuntimeError as exc:
            last_exc = exc
            if attempt >= max_attempts:
                break

            logging.warning(
                "[m365_cli] mail send pre-processing failed on attempt %d/%d: %s. Retrying once.",
                attempt,
                max_attempts,
                exc,
            )
            time.sleep(_MAIL_SEND_PREPROCESS_RETRY_DELAY_SECONDS)

    raise RuntimeError(
        "Email send was blocked because binary attachments could not be prepared as Blob links "
        f"after {max_attempts} attempts. {last_exc}"
    ) from last_exc


def _preprocess_mail_send(args: list[str]) -> list[str]:
    """Run all mail-send pre-processing steps in order.

    1. Unescape literal \\n / \\t in body
    2. Expand $(cat ...) shell substitutions
    3. Process --bodyFile flag
    4. Upload restricted attachments → inject download links into body
    """
    args = _unescape_body_literals(args)
    args = _expand_cat_substitutions(args)
    args = _process_bodyfile_flag(args)

    args, uploaded = _upload_restricted_attachments(args)
    if uploaded:
        download_html = _build_download_html(uploaded)
        args = _inject_download_into_body(args, download_html)

    return args


def _build_m365_launchers() -> list[tuple[list[str], str]]:
    """Build ordered launch strategies for m365 CLI.

    On Linux hosts, node_modules/.bin/m365 can exist without execute permission
    when copied from another environment. We therefore provide node-based and npx
    fallbacks that do not depend on execute bits of the shell shim.
    """
    app_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    local_bin = os.path.join(app_dir, "node_modules", ".bin", "m365")
    local_js = os.path.join(app_dir, "node_modules", "m365-cli", "bin", "m365.js")

    launchers: list[tuple[list[str], str]] = []

    # 1) Preferred: local bin stub when it is executable.
    if os.path.isfile(local_bin) and os.access(local_bin, os.X_OK):
        launchers.append(([local_bin], "local node_modules/.bin/m365"))

    # 2) Fallback: call local JS entry directly through node.
    node = shutil.which("node")
    if node and os.path.isfile(local_js):
        launchers.append(([node, local_js], "node m365-cli/bin/m365.js"))

    # 3) Next: global m365 command if available.
    global_m365 = shutil.which("m365")
    if global_m365:
        launchers.append(([global_m365], "global m365"))

    # 4) Last resort: npx package execution.
    npx = shutil.which("npx")
    if npx:
        launchers.append(([npx, "--yes", "m365-cli"], "npx m365-cli"))

    return launchers


def _looks_like_permission_denied(text: str) -> bool:
    lowered = (text or "").lower()
    return "permission denied" in lowered or "eacces" in lowered


async def m365_cli(params: M365CliParams) -> str:
    """Execute an m365 CLI command to interact with Microsoft 365 services.

    This is the ONLY tool that can actually SEND emails.  Use 'mail send' to
    deliver messages.  (The create_eml tool only writes .eml files to disk.)

    Provides access to Mail, Calendar, OneDrive, and SharePoint via the m365-cli tool.
    The user must be pre-authenticated (credentials stored under ~/.m365-cli).

    Email-specific features (auto-handled for 'mail send'):
    - --bodyFile /workspace/body.html: Reads file content as the email body (HTML supported)
    - $(cat /workspace/file.html) in body: Auto-expanded by reading the file
    - Only plain-text attachments (.txt, .md, .csv, .log) are sent directly.
      All binary files (pdf, images, office docs, etc.) in --attach are auto-uploaded
      to Azure Blob Storage with download links injected into the email body.

    Common commands:
    - mail send "<to>" "<subject>" "<body>" --json  (SEND an email)
    - mail send "<to>" "<subject>" --bodyFile /workspace/body.html --json  (body from file)
    - mail send "<to>" "<subject>" "<body>" --attach /workspace/report.pptx --json  (auto-uploads)
    - mail list --top 10 --json          (list recent emails)
    - mail read <id> --json              (read a specific email)
    - mail search "<query>" --json       (search emails)
    - calendar list --days 7 --json      (upcoming events)
    - calendar create "<title>" --start "2026-03-10T10:00:00" --end "2026-03-10T11:00:00" --json
    - onedrive ls --json                 (list OneDrive files)
    - sharepoint sites --json            (list SharePoint sites)

    Always use --json flag for structured, parseable output.
    """
    command_str = (params.command or "").strip()
    if not command_str:
        raise ValueError("command is required")

    # Security: block null bytes (the only metacharacter dangerous with
    # subprocess_exec which does NOT invoke a shell).  Characters like $,
    # backtick, |, ;, etc. are harmless in exec mode and commonly appear
    # in email bodies, subjects, or file paths generated by the agent.
    if "\x00" in command_str:
        raise ValueError("Command contains null bytes")

    # Build the command parts safely.
    # The command string is the sub-command after 'm365', e.g. 'mail list --top 5 --json'.
    args = shlex.split(command_str)

    # Pre-process mail send commands: expand file references, handle restricted attachments
    if len(args) >= 2 and args[0] == "mail" and args[1] == "send":
        args = _preprocess_mail_send_with_retry(args)

    logging.info(
        "[m365_cli] command=%s | args[0:4]=%s | len(args)=%d",
        args[0] if args else "?",
        args[:4],
        len(args),
    )

    env = os.environ.copy()
    # Ensure the m365-cli can find its credentials under the agent's home directory.
    home = os.path.expanduser("~")
    env.setdefault("HOME", home)

    launchers = _build_m365_launchers()
    if not launchers:
        return (
            "Error: m365 CLI launcher not found. Ensure Node.js and m365-cli are installed "
            "(run 'npm install' in the agent payload root, $DIGIBUDDY_PAYLOAD_ROOT)."
        )

    launcher_errors: list[str] = []
    output = ""
    for launcher_cmd, launcher_name in launchers:
        proc = None
        try:
            proc = await asyncio.create_subprocess_exec(
                *launcher_cmd,
                *args,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=env,
            )
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(),
                timeout=params.timeout_seconds,
            )
        except asyncio.TimeoutError:
            if proc is not None:
                proc.kill()
            return f"Error: command timed out after {params.timeout_seconds}s"
        except PermissionError as exc:
            launcher_errors.append(f"{launcher_name}: permission denied ({exc})")
            continue
        except FileNotFoundError as exc:
            launcher_errors.append(f"{launcher_name}: not found ({exc})")
            continue
        except OSError as exc:
            launcher_errors.append(f"{launcher_name}: {exc}")
            continue

        output = stdout.decode("utf-8", errors="replace").strip()
        err_output = stderr.decode("utf-8", errors="replace").strip()

        if proc.returncode == 0:
            logging.info(
                "[m365_cli] SUCCESS via %s | rc=%d | stdout_len=%d | stderr_len=%d | stdout_head=%s",
                launcher_name, proc.returncode, len(output), len(err_output),
                output[:200],
            )
            if err_output:
                logging.warning("[m365_cli] stderr (rc=0): %s", err_output[:300])
            break

        combined_error = err_output or output
        if _looks_like_permission_denied(combined_error):
            launcher_errors.append(
                f"{launcher_name}: {combined_error or f'exit code {proc.returncode}'}"
            )
            continue

        logging.error(
            "[m365_cli] FAILED via %s | rc=%d | error=%s",
            launcher_name, proc.returncode, combined_error[:300],
        )
        return f"Error (exit code {proc.returncode}):\n{combined_error}"
    else:
        return (
            "Error: unable to execute m365 CLI due to runtime launcher failures.\n"
            + "\n".join(launcher_errors[-4:])
        )

    # Truncate very large output to avoid context overflow
    max_chars = 50_000
    if len(output) > max_chars:
        output = output[:max_chars] + "\n\n... (output truncated)"

    return output


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="m365_cli", description=__doc__)
    parser.add_argument("command", help="m365 sub-command, e.g. 'mail list --top 5 --json'")
    parser.add_argument("--timeout", type=int, default=60, help="Command timeout in seconds")

    args = parser.parse_args(argv)
    print(
        asyncio.run(
            m365_cli(M365CliParams(command=args.command, timeout_seconds=args.timeout))
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
