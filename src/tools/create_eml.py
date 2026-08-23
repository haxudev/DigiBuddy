"""Write an RFC 5322 ``.eml`` file to disk. This does NOT send the message.

CLI:
    python -m create_eml --out /workspace/message.eml --from me@contoso.com \\
        --to you@contoso.com --subject "Hi" --body "Hello" [--attach FILE ...]
"""

import argparse
import asyncio
from pathlib import Path
from typing import Optional

from pydantic import BaseModel, Field


class EmlAttachment(BaseModel):
    path: str = Field(description="Absolute path to an existing file to attach")
    filename: Optional[str] = Field(default=None, description="Attachment filename override")
    mime_type: Optional[str] = Field(default=None, description="MIME type override (e.g. 'application/pdf')")


class CreateEmlParams(BaseModel):
    output_path: str = Field(
        description="Absolute output path for the .eml file (e.g. '/workspace/message.eml')"
    )
    from_addr: str = Field(description="From email address")
    to_addrs: list[str] = Field(description="Recipient email addresses")
    subject: str = Field(description="Email subject")
    body_text: str = Field(description="Plain-text body")
    attachments: list[EmlAttachment] = Field(default_factory=list, description="Optional file attachments")


async def create_eml(params: CreateEmlParams) -> str:
    """Create an RFC 5322 .eml file at the given path (does NOT send it).

    This tool only writes a .eml file to disk for offline use or download.
    It does NOT send the email.  To actually send an email, use the m365_cli
    tool with 'mail send' instead.

    Returns the saved file path.
    """

    import mimetypes
    from email.message import EmailMessage

    out = Path(params.output_path)
    if not out.is_absolute():
        raise ValueError("output_path must be an absolute path")
    out.parent.mkdir(parents=True, exist_ok=True)

    msg = EmailMessage()
    msg["From"] = params.from_addr
    msg["To"] = ", ".join([a.strip() for a in params.to_addrs if a.strip()])
    msg["Subject"] = params.subject
    msg.set_content(params.body_text)

    for att in params.attachments:
        p = Path(att.path)
        data = p.read_bytes()

        guessed = att.mime_type or (mimetypes.guess_type(p.name)[0] if p.name else None)
        maintype, subtype = (guessed.split("/", 1) if guessed and "/" in guessed else ("application", "octet-stream"))

        filename = att.filename or p.name or "attachment"
        msg.add_attachment(data, maintype=maintype, subtype=subtype, filename=filename)

    out.write_bytes(msg.as_bytes(policy=msg.policy.clone(linesep="\r\n")))
    return str(out)


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="create_eml", description=__doc__)
    parser.add_argument("--out", required=True, help="Absolute output path for the .eml file")
    parser.add_argument("--from", dest="from_addr", required=True)
    parser.add_argument("--to", action="append", required=True, help="Repeat for each recipient")
    parser.add_argument("--subject", required=True)
    parser.add_argument("--body", required=True, help="Plain-text body")
    parser.add_argument("--attach", action="append", default=[], help="Repeat for each file")

    args = parser.parse_args(argv)
    print(
        asyncio.run(
            create_eml(
                CreateEmlParams(
                    output_path=args.out,
                    from_addr=args.from_addr,
                    to_addrs=args.to,
                    subject=args.subject,
                    body_text=args.body,
                    attachments=[EmlAttachment(path=p) for p in args.attach],
                )
            )
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
