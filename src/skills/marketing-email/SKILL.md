---
name: marketing-email
description: Create professional HTML email campaigns (EDM) for enterprise internal distribution. Produces Outlook-compatible, responsive HTML emails with Microsoft brand styling. Supports single-language and multilingual (简中/繁中/English) layouts. Use when asked to create EDM, marketing email, newsletter HTML, email blast, or email campaign content.
---

# Marketing Email / EDM Skill

## Overview

Create elegant, professional HTML emails (EDM — Email Direct Marketing) for enterprise internal audiences. Output is a standalone `.html` file ready to paste into Outlook or any email platform.

**Target audience**: Enterprise internal users (Microsoft employees, partners)
**Primary email client**: Desktop Outlook (Word rendering engine) — the most restrictive HTML email renderer
**Output**: Single self-contained `.html` file written to `/tmp`

## Workflow

### Preferred: MJML → HTML (Recommended)

MJML handles Outlook compatibility automatically. Use this approach when possible.

1. Write MJML source (`.mjml` file in `/tmp`)
2. Compile to HTML: `npx mjml /tmp/email.mjml -o /tmp/email.html`
3. Review and deliver the `.html` file

```xml
<mjml>
  <mj-head>
    <mj-attributes>
      <mj-all font-family="'Segoe UI','等线','DengXian','Microsoft YaHei','PingFang SC',Arial,sans-serif" />
      <mj-text font-size="15px" line-height="1.6" color="#333333" />
    </mj-attributes>
  </mj-head>
  <mj-body width="600px" background-color="#F3F2F1">
    <!-- Banner -->
    <mj-section background-color="#0078D4" padding="30px 40px">
      <mj-column>
        <mj-text color="#ffffff" font-size="24px" font-weight="700">
          Email Title Here
        </mj-text>
      </mj-column>
    </mj-section>

    <!-- Content -->
    <mj-section background-color="#ffffff" padding="30px 40px">
      <mj-column>
        <mj-text>Body content here</mj-text>
      </mj-column>
    </mj-section>

    <!-- CTA -->
    <mj-section background-color="#ffffff" padding="0 40px 30px">
      <mj-column>
        <mj-button background-color="#0078D4" color="#ffffff" font-size="15px"
                   font-weight="600" inner-padding="12px 30px" href="https://example.com">
          Call to Action
        </mj-button>
      </mj-column>
    </mj-section>

    <!-- Footer -->
    <mj-section background-color="#F3F2F1" padding="20px 40px">
      <mj-column>
        <mj-text font-size="12px" color="#999999">
          Footer disclaimer text
        </mj-text>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>
```

### Fallback: Raw HTML

When MJML is unavailable or for fine-tuned control, write raw HTML following the rules below.

## EDM Design Standards

### Layout

- **Pure `<table role="presentation">` layout** — no `<div>` layout, no CSS Grid, no Flexbox
- Content area: **single `<table>`**, do NOT nest tables inside content cells (pricing tables may use their own table)
- Fixed width: **`width="600"`** on the outer wrapper table
- Maximum **2 columns** in content area (pricing/comparison tables may have more)
- **ALL styles inline** — do NOT use `<style>` blocks (Outlook's Word renderer ignores them)
- Use **MSO conditional comments** `<!--[if mso]>...<![endif]-->` for Outlook-specific fallbacks
- `cellpadding="0" cellspacing="0" border="0"` on every table
- Use `align="center"` on the outer table for centering in webmail clients

### Font Stack

```
font-family: 'Segoe UI','等线','DengXian','Microsoft YaHei','PingFang SC',Arial,sans-serif;
```

- **Primary**: Segoe UI (Windows), 等线/DengXian (CJK on modern Windows)
- **Fallback**: Microsoft YaHei (CJK on older Windows), PingFang SC (macOS CJK), Arial (universal)
- MSO conditional font fallback should also prioritize 等线/DengXian:

```html
<!--[if mso]>
<style>
  body, td, th { font-family: '等线','DengXian','Segoe UI','Microsoft YaHei',Arial,sans-serif !important; }
</style>
<![endif]-->
```

### Content Formatting

| Element | Implementation | NOT |
|---------|---------------|-----|
| Headings | `<p style="font-size:20px; font-weight:700; ...">` | ~~`<h1>`–`<h6>`~~ (inconsistent rendering) |
| Bullet lists | `&bull;` (small circle) character + `&nbsp;` spacing | ~~▶~~ ~~nested tables~~ ~~`<ul>`/`<li>`~~ |
| Links | `<a style="color:#0078D4; text-decoration:none;">` | — |
| Link blocks | `<p>` with `background:#F3F6F9; border-left:3px solid #0078D4; padding:12px 16px;` | — |
| Images | `<img style="display:block;" width="XXX" alt="descriptive text">` | — |
| Spacers | `<td style="height:20px; line-height:20px; font-size:1px;">&nbsp;</td>` | — |

### Color Palette (Microsoft Brand)

| Element | Color | CSS |
|---------|-------|-----|
| Banner background | Microsoft Blue | `background-color:#0078D4` |
| Banner text | White | `color:#ffffff` |
| Accent stripe | Cyan 4px | `border-top:4px solid #50E6FF` |
| Section title | Blue + underline | `color:#0078D4; border-bottom:2px solid #E3E3E3` |
| Body text | Dark gray | `color:#333333` |
| Links | Blue, no underline | `color:#0078D4; text-decoration:none` |
| Pricing table header | Blue bg, white text | `background:#0078D4; color:#fff` |
| Footer background | Light gray | `background-color:#F3F2F1` |
| Footer text | Muted gray | `color:#999999; font-size:12px` |

### CTA Button

Outlook does not support `border-radius` or many `display` properties on `<a>`. Use the VML fallback pattern:

```html
<!-- CTA Button (Outlook-safe) -->
<table role="presentation" cellpadding="0" cellspacing="0" border="0">
  <tr>
    <td align="center" style="background:#0078D4; border-radius:4px;">
      <!--[if mso]>
      <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" href="https://example.com"
        style="height:44px;v-text-anchor:middle;width:200px;" arcsize="10%" fillcolor="#0078D4" stroke="f">
        <v:textbox inset="0,0,0,0"><center style="color:#ffffff;font-family:'Segoe UI',Arial;font-size:15px;font-weight:600;">
          Call to Action
        </center></v:textbox>
      </v:roundrect>
      <![endif]-->
      <!--[if !mso]><!-->
      <a href="https://example.com" style="display:inline-block;background:#0078D4;color:#ffffff;padding:12px 30px;font-weight:600;font-size:15px;text-decoration:none;border-radius:4px;font-family:'Segoe UI',Arial,sans-serif;">
        Call to Action
      </a>
      <!--<![endif]-->
    </td>
  </tr>
</table>
```

## Language Rules

### Default behavior
- **Follow the user's requested language**
- If no language specified, match the language the user wrote in
- **Do NOT default to trilingual** — only produce multilingual when explicitly requested

### Trilingual layout (only when explicitly requested)

When the user asks for 简中 + 繁中 + English (三语版):

1. **Stack vertically**: Complete 简中 → Complete 繁中 → Complete English
2. **Never interleave** languages paragraph by paragraph
3. Add a **language badge** at the start of each section:

```html
<td style="background:#0078D4;color:#fff;padding:4px 12px;font-size:12px;font-weight:600;border-radius:2px;display:inline-block;">
  简体中文
</td>
```

4. Add **anchor navigation** at the top:

```html
<p style="font-size:13px;color:#666;margin:0 0 10px;">
  <a href="#zh-cn" style="color:#0078D4;text-decoration:none;">简体中文</a> &nbsp;|&nbsp;
  <a href="#zh-tw" style="color:#0078D4;text-decoration:none;">繁體中文</a> &nbsp;|&nbsp;
  <a href="#en" style="color:#0078D4;text-decoration:none;">English</a>
</p>
```

5. Separate language blocks with a **5px gray divider**:

```html
<td style="height:5px;background:#E3E3E3;font-size:1px;line-height:1px;">&nbsp;</td>
```

### Translation quality
- Simplified Chinese (简中): Natural mainland China terminology
- Traditional Chinese (繁中): Use Taiwan/HK terminology where different (e.g., 軟體 not 软件, 雲端 not 云端)
- English: Professional business English, concise and direct

## HTML Email Skeleton (Raw HTML Template)

```html
<!DOCTYPE html>
<html lang="zh-CN" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <!--[if mso]>
  <noscript><xml>
    <o:OfficeDocumentSettings>
      <o:PixelsPerInch>96</o:PixelsPerInch>
    </o:OfficeDocumentSettings>
  </xml></noscript>
  <style>
    body, td, th { font-family: '等线','DengXian','Segoe UI','Microsoft YaHei',Arial,sans-serif !important; }
  </style>
  <![endif]-->
</head>
<body style="margin:0;padding:0;background-color:#F3F2F1;font-family:'Segoe UI','等线','DengXian','Microsoft YaHei','PingFang SC',Arial,sans-serif;">

  <!-- Outer wrapper -->
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#F3F2F1;">
    <tr>
      <td align="center" style="padding:20px 0;">

        <!-- Email body 600px -->
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="background-color:#ffffff;">

          <!-- Accent stripe -->
          <tr><td style="height:4px;background-color:#50E6FF;font-size:1px;line-height:1px;">&nbsp;</td></tr>

          <!-- Banner -->
          <tr>
            <td style="background-color:#0078D4;padding:30px 40px;">
              <p style="margin:0;font-size:24px;font-weight:700;color:#ffffff;line-height:1.3;">
                Email Title
              </p>
              <p style="margin:8px 0 0;font-size:14px;color:rgba(255,255,255,0.85);line-height:1.4;">
                Subtitle or date
              </p>
            </td>
          </tr>

          <!-- Content section -->
          <tr>
            <td style="padding:30px 40px;">
              <!-- Section title -->
              <p style="margin:0 0 16px;font-size:18px;font-weight:600;color:#0078D4;border-bottom:2px solid #E3E3E3;padding-bottom:8px;">
                Section Title
              </p>
              <!-- Body text -->
              <p style="margin:0 0 12px;font-size:15px;color:#333333;line-height:1.6;">
                Body content goes here. Use inline styles for everything.
              </p>
              <!-- Bullet list -->
              <p style="margin:0 0 8px;font-size:15px;color:#333333;line-height:1.6;">
                &bull;&nbsp; First bullet point<br>
                &bull;&nbsp; Second bullet point<br>
                &bull;&nbsp; Third bullet point
              </p>
              <!-- Link block -->
              <p style="margin:16px 0;padding:12px 16px;background:#F3F6F9;border-left:3px solid #0078D4;font-size:14px;line-height:1.5;">
                <a href="https://example.com" style="color:#0078D4;text-decoration:none;font-weight:600;">
                  Resource Link Title →
                </a><br>
                <span style="color:#666;font-size:13px;">Brief description of the linked resource</span>
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color:#F3F2F1;padding:20px 40px;">
              <p style="margin:0;font-size:12px;color:#999999;line-height:1.5;">
                This email was sent to internal recipients. Please do not forward externally.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>

</body>
</html>
```

## Outlook Compatibility Checklist

Before delivering the final HTML, verify:

- [ ] All styles are inline (no `<style>` in `<head>` except inside `<!--[if mso]>`)
- [ ] All tables have `role="presentation" cellpadding="0" cellspacing="0" border="0"`
- [ ] Outer table is `width="600"` (not `max-width` — Outlook ignores it)
- [ ] No `<div>` used for layout (only for wrapping non-layout content)
- [ ] No CSS `display:flex`, `display:grid`, `position:absolute/relative`
- [ ] No `border-radius` on `<td>` without VML fallback
- [ ] All images have explicit `width` and `alt` attributes, `style="display:block;"`
- [ ] Font stack includes CJK fonts: `'等线','DengXian','Microsoft YaHei'`
- [ ] MSO conditional block sets CJK font fallback
- [ ] `<html>` tag includes `xmlns:v` and `xmlns:o` for VML support
- [ ] Spacer rows use `height` + `line-height` + `font-size:1px` + `&nbsp;`
- [ ] No `margin` on `<td>` (use `padding` instead — Outlook ignores td margin)

## Common Patterns

### Pricing / Comparison Table

```html
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
  <tr>
    <th style="background:#0078D4;color:#fff;padding:10px 12px;font-size:13px;font-weight:600;text-align:left;border:1px solid #E3E3E3;">Feature</th>
    <th style="background:#0078D4;color:#fff;padding:10px 12px;font-size:13px;font-weight:600;text-align:center;border:1px solid #E3E3E3;">Basic</th>
    <th style="background:#0078D4;color:#fff;padding:10px 12px;font-size:13px;font-weight:600;text-align:center;border:1px solid #E3E3E3;">Pro</th>
  </tr>
  <tr>
    <td style="padding:10px 12px;font-size:14px;border:1px solid #E3E3E3;">Feature name</td>
    <td style="padding:10px 12px;font-size:14px;text-align:center;border:1px solid #E3E3E3;">✓</td>
    <td style="padding:10px 12px;font-size:14px;text-align:center;border:1px solid #E3E3E3;">✓</td>
  </tr>
</table>
```

### Key Metric / Highlight Box

```html
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
  <tr>
    <td width="33%" align="center" style="padding:16px 8px;">
      <p style="margin:0;font-size:28px;font-weight:700;color:#0078D4;">99.9%</p>
      <p style="margin:4px 0 0;font-size:13px;color:#666;">SLA Uptime</p>
    </td>
    <td width="33%" align="center" style="padding:16px 8px;">
      <p style="margin:0;font-size:28px;font-weight:700;color:#0078D4;">50+</p>
      <p style="margin:4px 0 0;font-size:13px;color:#666;">Azure Regions</p>
    </td>
    <td width="33%" align="center" style="padding:16px 8px;">
      <p style="margin:0;font-size:28px;font-weight:700;color:#0078D4;">24/7</p>
      <p style="margin:4px 0 0;font-size:13px;color:#666;">Support</p>
    </td>
  </tr>
</table>
```

## Email File Output (.eml)

When the user requests a **downloadable email file** (e.g., "生成邮件文件", "create an email I can open in Outlook", "generate .msg", "generate email file"), produce an `.eml` file using the bundled helper script.

> **CRITICAL: NEVER create `.msg` files.**
> Outlook `.msg` is a proprietary OLE2/CFBF binary format with MAPI properties.
> Python's `email` module creates MIME/RFC 5322 messages — saving these as `.msg`
> produces a **corrupt file that Outlook cannot open**. Always use `.eml` instead.
> `.eml` files open natively in Outlook, Thunderbird, and Apple Mail.

### Using the helper script

```python
import sys, os
sys.path.insert(0, os.path.join(os.environ.get("AGENT_SKILLS_DIR",
    "/home/site/wwwroot/.github/skills"), "marketing-email", "scripts"))
from create_eml import create_eml

# From an HTML file (after MJML compilation or raw HTML generation)
path = create_eml(
    html_path="/tmp/campaign.html",
    subject="Azure AI 最新动态 | Latest Updates",
    output_path="/tmp/azure_ai_updates.eml",
    sender="noreply@microsoft.com",
    to="all-hands@microsoft.com",
    importance="high",   # optional: "high", "normal", "low"
)
```

### From an HTML string

```python
path = create_eml(
    html="<html><body><h1>Hello</h1></body></html>",
    subject="Quick Update",
    output_path="/tmp/quick_update.eml",
)
```

### Workflow: MJML → HTML → .eml

1. Write MJML source to `/tmp/email.mjml`
2. Compile: `npx mjml /tmp/email.mjml -o /tmp/email.html`
3. Convert to .eml:
   ```python
   path = create_eml(
       html_path="/tmp/email.html",
       subject="Campaign Subject",
       output_path="/tmp/campaign.eml",
   )
   ```
4. Deliver both `/tmp/email.html` (for preview) and `/tmp/campaign.eml` (for Outlook)

### Features

- **CJK support**: UTF-8 encoding throughout, subject and body handle 中文/繁中/日本語
- **Multipart MIME**: Includes both `text/plain` (auto-extracted) and `text/html` parts
- **Outlook priority**: Set `importance="high"` to show the red exclamation mark in Outlook
- **Zero dependencies**: Uses only Python standard library (`email`, `datetime`)

## Output

- Write the final HTML to `/tmp/<descriptive-name>.html` (e.g., `/tmp/foundry_quota_update_edm.html`)
- When the user wants a downloadable email file, also generate `/tmp/<descriptive-name>.eml`
- If using MJML, also keep the `.mjml` source in `/tmp` for future edits
- The file delivery pipeline will automatically upload to blob storage and provide a download link
- **NEVER output `.msg` files** — always use `.eml` for downloadable email files
