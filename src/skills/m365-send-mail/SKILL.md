---
name: m365-send-mail
description: "Send emails via Microsoft 365 using the m365-cli tool. Use when the user asks to send an email, compose and send a message, email someone, or reply to someone via M365/Outlook. Also use when the user wants to list, search, or read emails through their M365 account. Do NOT use for creating .eml files (use create_eml instead) or for marketing email HTML templates (use marketing-email skill)."
---

# M365 Send Mail Skill

## Overview

Send real emails through the user's Microsoft 365 account using the `m365_cli` tool. This skill enables the agent to compose and send emails, list inbox messages, read specific emails, search mail, and manage attachments — all via the Microsoft Graph API through the m365-cli.

## Prerequisites

- The `m365_cli` tool must be available
- User must be authenticated (credentials stored in Key Vault and restored at runtime, or locally via `m365 login`)
- Required Graph permissions: `Mail.ReadWrite`, `Mail.Send`

## Workflow

### Sending an Email

Default workflow:

1. Confirm the recipient, subject, and body with the user.
2. Call one `m365_cli` `mail send` command.
3. If there are files, pass them through `--attach` and let the tool handle attachment-vs-link conversion automatically.
4. Report success or failure.

```
m365_cli command: mail send "recipient@example.com" "Subject Line" "Email body text here" --json
```

### Sending with HTML Body from a File

When the email body is generated as an HTML file (e.g. by a skill that creates formatted content), use `--bodyFile` to read the file content as the body:

```
m365_cli command: mail send "recipient@example.com" "Subject" --bodyFile /tmp/email_body.html --json
```

**IMPORTANT**: Do NOT use `$(cat /tmp/...)` shell syntax — it will NOT be expanded. Always use `--bodyFile` when the body is in a file, or pass the content inline.

### Sending with Attachments

If the user wants to attach files, the files must exist on disk (e.g. in `/tmp`):

```
m365_cli command: mail send "recipient@example.com" "Subject" "Body" --attach /tmp/report.pdf --json
```

Multiple attachments:

```
m365_cli command: mail send "recipient@example.com" "Subject" "Body" --attach /tmp/file1.pdf /tmp/image.png --json
```

### Attachment Handling (Auto-Upload for Binary Files)

Only plain-text files (.txt, .md, .csv, .log) are sent as direct email attachments. **All binary files** — including PDF, images (png/jpg/gif), Office documents (pptx/docx/xlsx), archives (zip), and others — are **automatically** uploaded to Azure Blob Storage with elegant download links injected into the email body.

1. Put every file into `--attach`.
2. The tool uploads binary files to Azure Blob Storage.
3. The tool injects download links into the email body with an HTML download card.
4. The tool keeps only plain-text files as direct attachments.
5. If Blob-link preparation fails, the tool retries once automatically before blocking the send.

Example — the pptx and pdf are both auto-uploaded, only the .txt stays attached:
```
m365_cli command: mail send "user@example.com" "Weekly Report" "See report below" --attach /tmp/report.pptx /tmp/summary.pdf /tmp/notes.txt --json
```

If ALL files are binary, just list them in `--attach` — the tool handles the rest:
```
m365_cli command: mail send "user@example.com" "Deliverables" "Please find the documents below" --attach /tmp/deck.pptx /tmp/chart.png --json
```

### Listing Emails

```
m365_cli command: mail list --top 10 --json
```

List from specific folder:

```
m365_cli command: mail list --folder sent --top 5 --json
m365_cli command: mail list --folder drafts --json
```

### Reading a Specific Email

```
m365_cli command: mail read <message-id> --json
```

Use `--force` to bypass trusted sender filtering:

```
m365_cli command: mail read <message-id> --force --json
```

### Searching Emails

```
m365_cli command: mail search "project update" --top 20 --json
```

### Managing Attachments

List attachments on an email:

```
m365_cli command: mail attachments <message-id> --json
```

Download an attachment:

```
m365_cli command: mail download-attachment <message-id> <attachment-id> /tmp/downloaded-file.pdf --json
```

## Important Notes

- **Always use `--json`** for structured output that can be parsed and presented cleanly
- **Confirm before sending**: Always confirm recipient, subject, and body with the user before calling `mail send`
- **Keep the command simple**: Prefer one `mail send ... --attach ... --json` command and let the tool handle binary attachment staging automatically.
- **Use `--bodyFile` for file-based bodies**: When the body content is in a file (HTML, generated content), use `--bodyFile /tmp/file.html` instead of `$(cat ...)`. Shell substitution does NOT work.
- **Attachment handling**: Only plain-text files (.txt, .md, .csv, .log) are sent as direct attachments. ALL binary files (PDF, images, Office docs, archives, etc.) are auto-uploaded to Azure Blob with download links injected into the email body.
- **Attachment paths**: Files to attach must be absolute paths to existing files (typically under `/tmp`)
- **Trusted senders**: By default, email content from untrusted senders is filtered. Use `--force` to read full content when needed
- **Error handling**: If the command fails with "Not authenticated", inform the user that m365 login is required or credentials need to be refreshed in Key Vault

## Composing Elegant Emails (HTML)

When composing rich/formatted emails (newsletters, reports, summaries), write a self-contained HTML file and use `--bodyFile`:

```
# 1. Write HTML to file
write_file /tmp/email_body.html with HTML content

# 2. Send with --bodyFile
m365_cli command: mail send "user@example.com" "Subject" --bodyFile /tmp/email_body.html --json
```

### HTML Email Rules (Outlook Desktop Compatibility)

1. **Table-based layout only**: Use `<table width="100%">` wrappers — no `<div>`, flexbox, grid, floats.
2. **No forced text colors**: Do NOT set `color:#333` or any dark text color on body text. Outlook dark mode auto-inverts unforced colors. Forcing dark colors makes text invisible on dark backgrounds.
3. **Background via `bgcolor`**: Use `bgcolor` attribute on `<td>` instead of CSS `background-color` for colored sections. Outlook respects `bgcolor` and can invert it in dark mode.
4. **Font stack**: `font-family:'Segoe UI',Calibri,Arial,sans-serif`
5. **Max width 640px**: Wrap content in a centered table with `max-width:640px`.
6. **No `<style>` blocks**: Outlook strips `<style>` tags. Use only inline `style` attributes.
7. **No CSS classes, float, position, flexbox, grid**: All stripped by Outlook.
8. **Use `<br>` for line breaks**: Not `\n` — literal `\n` in inline body text is auto-converted, but for HTML files use `<br>` or `<p>` tags.

### Example HTML Body Template

```html
<table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation">
<tr><td align="center">
<table width="640" cellpadding="0" cellspacing="0" border="0" role="presentation"
       style="max-width:640px;width:100%;font-family:'Segoe UI',Calibri,Arial,sans-serif;">
  <tr><td style="padding:24px 20px;font-size:14px;line-height:1.6;">
    <p style="font-size:20px;font-weight:700;margin:0 0 16px;">Title Here</p>
    <p>Body paragraph goes here. No forced text color needed.</p>
  </td></tr>
</table>
</td></tr></table>
```

## Example Interaction

**User**: 帮我给 alice@contoso.com 发一封邮件，主题是"会议纪要"，内容是今天的会议总结。

**Agent**:
1. Confirm: "我将给 alice@contoso.com 发送邮件，主题：会议纪要。确认发送吗？"
2. On confirmation, call:
   ```
   m365_cli command: mail send "alice@contoso.com" "会议纪要" "今天的会议总结..." --json
   ```
3. Report: "邮件已成功发送给 alice@contoso.com。"
