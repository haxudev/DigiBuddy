---
name: pdf
description: Use this skill whenever the user wants to do anything with PDF files. This includes reading or extracting text/tables from PDFs, combining or merging multiple PDFs into one, splitting PDFs apart, rotating pages, adding watermarks, creating new PDFs, filling PDF forms, encrypting/decrypting PDFs, extracting images, and OCR on scanned PDFs to make them searchable. If the user mentions a .pdf file or asks to produce one, use this skill.
license: Proprietary. LICENSE.txt has complete terms
---

# PDF Processing Guide

## Overview

This guide covers essential PDF processing operations using Python libraries and command-line tools. For advanced features, JavaScript libraries, and detailed examples, see REFERENCE.md. If you need to fill out a PDF form, read FORMS.md and follow its instructions.

## Quick Start

```python
from pypdf import PdfReader, PdfWriter

# Read a PDF
reader = PdfReader("document.pdf")
print(f"Pages: {len(reader.pages)}")

# Extract text
text = ""
for page in reader.pages:
    text += page.extract_text()
```

## Python Libraries

### pypdf - Basic Operations

#### Merge PDFs
```python
from pypdf import PdfWriter, PdfReader

writer = PdfWriter()
for pdf_file in ["doc1.pdf", "doc2.pdf", "doc3.pdf"]:
    reader = PdfReader(pdf_file)
    for page in reader.pages:
        writer.add_page(page)

with open("merged.pdf", "wb") as output:
    writer.write(output)
```

#### Split PDF
```python
reader = PdfReader("input.pdf")
for i, page in enumerate(reader.pages):
    writer = PdfWriter()
    writer.add_page(page)
    with open(f"page_{i+1}.pdf", "wb") as output:
        writer.write(output)
```

#### Extract Metadata
```python
reader = PdfReader("document.pdf")
meta = reader.metadata
print(f"Title: {meta.title}")
print(f"Author: {meta.author}")
print(f"Subject: {meta.subject}")
print(f"Creator: {meta.creator}")
```

#### Rotate Pages
```python
reader = PdfReader("input.pdf")
writer = PdfWriter()

page = reader.pages[0]
page.rotate(90)  # Rotate 90 degrees clockwise
writer.add_page(page)

with open("rotated.pdf", "wb") as output:
    writer.write(output)
```

### pdfplumber - Text and Table Extraction

#### Extract Text with Layout
```python
import pdfplumber

with pdfplumber.open("document.pdf") as pdf:
    for page in pdf.pages:
        text = page.extract_text()
        print(text)
```

#### Extract Tables
```python
with pdfplumber.open("document.pdf") as pdf:
    for i, page in enumerate(pdf.pages):
        tables = page.extract_tables()
        for j, table in enumerate(tables):
            print(f"Table {j+1} on page {i+1}:")
            for row in table:
                print(row)
```

#### Advanced Table Extraction
```python
import pandas as pd

with pdfplumber.open("document.pdf") as pdf:
    all_tables = []
    for page in pdf.pages:
        tables = page.extract_tables()
        for table in tables:
            if table:  # Check if table is not empty
                df = pd.DataFrame(table[1:], columns=table[0])
                all_tables.append(df)

# Combine all tables
if all_tables:
    combined_df = pd.concat(all_tables, ignore_index=True)
    combined_df.to_excel("extracted_tables.xlsx", index=False)
```

### reportlab - Create PDFs

#### Basic PDF Creation
```python
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas

c = canvas.Canvas("hello.pdf", pagesize=letter)
width, height = letter

# Add text
c.drawString(100, height - 100, "Hello World!")
c.drawString(100, height - 120, "This is a PDF created with reportlab")

# Add a line
c.line(100, height - 140, 400, height - 140)

# Save
c.save()
```

#### Create PDF with Multiple Pages
```python
from reportlab.lib.pagesizes import letter
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, PageBreak
from reportlab.lib.styles import getSampleStyleSheet

doc = SimpleDocTemplate("report.pdf", pagesize=letter)
styles = getSampleStyleSheet()
story = []

# Add content
title = Paragraph("Report Title", styles['Title'])
story.append(title)
story.append(Spacer(1, 12))

body = Paragraph("This is the body of the report. " * 20, styles['Normal'])
story.append(body)
story.append(PageBreak())

# Page 2
story.append(Paragraph("Page 2", styles['Heading1']))
story.append(Paragraph("Content for page 2", styles['Normal']))

# Build PDF
doc.build(story)
```

#### CJK (Chinese/Japanese/Korean) Font Support

**CRITICAL**: ReportLab's built-in fonts (Helvetica, Times-Roman, Courier) do NOT support CJK characters. Using them renders Chinese/Japanese/Korean text as black boxes (□). You MUST register and use a CJK-capable font whenever the content may contain CJK characters.

**Option 1 — Noto Sans CJK TTF (PREFERRED, best rendering quality)**:
```python
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
import glob

# Register Noto Sans CJK (installed in Docker via fonts-noto-cjk)
_CJK_FONT_CANDIDATES = [
    "/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/noto-cjk/NotoSansCJKsc-Regular.otf",
] + glob.glob("/usr/share/fonts/**/NotoSansCJK*Regular*", recursive=True)

_cjk_font_path = next((p for p in _CJK_FONT_CANDIDATES if __import__('os').path.exists(p)), None)
if _cjk_font_path:
    pdfmetrics.registerFont(TTFont("NotoSansCJK", _cjk_font_path))
    CJK_FONTNAME = "NotoSansCJK"
else:
    # Fallback to CID font (see Option 2)
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont
    pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
    CJK_FONTNAME = "STSong-Light"

# Create CJK-aware styles
styles = getSampleStyleSheet()
styles.add(ParagraphStyle(name='CJK', fontName=CJK_FONTNAME, fontSize=12, leading=16))
styles.add(ParagraphStyle(name='CJKTitle', fontName=CJK_FONTNAME, fontSize=24, leading=30, spaceAfter=12))
styles.add(ParagraphStyle(name='CJKHeading', fontName=CJK_FONTNAME, fontSize=16, leading=20, spaceBefore=12, spaceAfter=6))

# Use in paragraphs
story.append(Paragraph("中文标题", styles['CJKTitle']))
story.append(Paragraph("这是中文正文内容。", styles['CJK']))
```

**Option 2 — ReportLab CID Fonts (no TTF file needed, acceptable quality)**:
```python
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont

pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))  # Simplified Chinese
# Other CID fonts: "MSung-Light" (Traditional Chinese), "HeiseiMin-W3" (Japanese), "HYSMyeongJoNeatly-Medium" (Korean)

# Use in canvas
c.setFont("STSong-Light", 12)
c.drawString(100, 700, "这是中文文本")
```

**IMPORTANT: When to use CJK fonts**: Detect CJK characters in content and auto-switch:
```python
import re
def has_cjk(text):
    return bool(re.search(r'[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]', text))

# Choose font based on content
fontName = CJK_FONTNAME if has_cjk(user_text) else "Helvetica"
```

#### Emoji & Symbol Font Support

**CRITICAL**: ReportLab's built-in fonts and CJK fonts do NOT include emoji characters (💎🔷⭐✅ etc.). Emoji will render as `�` (replacement character) or tofu boxes. The Docker image has `NotoColorEmoji.ttf` installed for emoji support.

**Register emoji font and build a font-switching helper**:
```python
import re, os
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

# Register emoji font (installed via fonts-noto-color-emoji)
_EMOJI_FONT_CANDIDATES = [
    "/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf",
    "/usr/share/fonts/truetype/noto-color-emoji/NotoColorEmoji.ttf",
]
EMOJI_FONTNAME = None
for _p in _EMOJI_FONT_CANDIDATES:
    if os.path.exists(_p):
        try:
            pdfmetrics.registerFont(TTFont("NotoEmoji", _p))
            EMOJI_FONTNAME = "NotoEmoji"
        except Exception:
            pass
        break

# Detect emoji characters
_EMOJI_RE = re.compile(
    "["
    "\U0001F300-\U0001F9FF"  # Misc Symbols & Pictographs, Emoticons, etc.
    "\U00002702-\U000027B0"  # Dingbats
    "\U00002600-\U000026FF"  # Misc Symbols
    "\U0000FE00-\U0000FE0F"  # Variation Selectors
    "\U0000200D"             # ZWJ
    "\U0001FA00-\U0001FA6F"  # Chess Symbols, Extended-A
    "\U0001FA70-\U0001FAFF"  # Symbols Extended-A
    "]+"
)

def has_emoji(text):
    return bool(_EMOJI_RE.search(str(text)))

def safe_paragraph_text(text, body_font="NotoSansCJK"):
    """Wrap text with <font> tags for ReportLab Paragraph, switching to emoji font for emoji chars.
    If emoji font is not available, emoji chars are kept as-is (may render as tofu)."""
    if not EMOJI_FONTNAME or not has_emoji(text):
        return text
    parts = []
    last = 0
    for m in _EMOJI_RE.finditer(text):
        if m.start() > last:
            parts.append(text[last:m.start()])
        parts.append(f'<font name="{EMOJI_FONTNAME}">{m.group()}</font>')
        last = m.end()
    if last < len(text):
        parts.append(text[last:])
    return "".join(parts)

# Usage in Paragraph:
story.append(Paragraph(safe_paragraph_text("💎 优势分析 Strengths", body_font=CJK_FONTNAME), styles['CJKTitle']))
```

**If the color emoji font fails to register** (ReportLab may not fully support CBDT bitmap fonts), use Unicode geometric shapes as reliable substitutes — these are included in Noto Sans CJK:

| Emoji | Substitute | Unicode | Description |
|-------|-----------|---------|-------------|
| 💎🔷🔹 | ◆ or ◇ | U+25C6 / U+25C7 | Diamond |
| ⭐🌟 | ★ or ☆ | U+2605 / U+2606 | Star |
| ✅ | ✓ | U+2713 | Check mark |
| ❌ | ✗ | U+2717 | Cross mark |
| 🔴🟢🔵 | ● | U+25CF | Filled circle |
| 🟡🟠🟣 | ○ | U+25CB | Empty circle |
| ▶️ | ▶ | U+25B6 | Triangle |
| 📌 | ■ | U+25A0 | Square |

Use `drawString` with colored fills for visual distinction:
```python
c.setFillColor(colors.HexColor("#2196F3"))  # blue
c.setFont(CJK_FONTNAME, 14)
c.drawString(x, y, "◆")  # colored diamond as bullet
c.setFillColor(colors.black)
c.drawString(x + 18, y, "优势分析")
```

**Do NOT strip or remove emoji from content** — always attempt to render them. Use font switching first; fall back to geometric substitutes only if the emoji font cannot be registered.

#### Subscripts and Superscripts

**IMPORTANT**: Never use Unicode subscript/superscript characters (₀₁₂₃₄₅₆₇₈₉, ⁰¹²³⁴⁵⁶⁷⁸⁹) in ReportLab PDFs. The built-in fonts do not include these glyphs, causing them to render as solid black boxes.

Instead, use ReportLab's XML markup tags in Paragraph objects:
```python
from reportlab.platypus import Paragraph
from reportlab.lib.styles import getSampleStyleSheet

styles = getSampleStyleSheet()

# Subscripts: use <sub> tag
chemical = Paragraph("H<sub>2</sub>O", styles['Normal'])

# Superscripts: use <super> tag
squared = Paragraph("x<super>2</super> + y<super>2</super>", styles['Normal'])
```

For canvas-drawn text (not Paragraph objects), manually adjust font the size and position rather than using Unicode subscripts/superscripts.

## Command-Line Tools

### pdftotext (poppler-utils)
```bash
# Extract text
pdftotext input.pdf output.txt

# Extract text preserving layout
pdftotext -layout input.pdf output.txt

# Extract specific pages
pdftotext -f 1 -l 5 input.pdf output.txt  # Pages 1-5
```

### qpdf
```bash
# Merge PDFs
qpdf --empty --pages file1.pdf file2.pdf -- merged.pdf

# Split pages
qpdf input.pdf --pages . 1-5 -- pages1-5.pdf
qpdf input.pdf --pages . 6-10 -- pages6-10.pdf

# Rotate pages
qpdf input.pdf output.pdf --rotate=+90:1  # Rotate page 1 by 90 degrees

# Remove password
qpdf --password=mypassword --decrypt encrypted.pdf decrypted.pdf
```

### pdftk (if available)
```bash
# Merge
pdftk file1.pdf file2.pdf cat output merged.pdf

# Split
pdftk input.pdf burst

# Rotate
pdftk input.pdf rotate 1east output rotated.pdf
```

## Common Tasks

### Extract Text from Scanned PDFs
```python
# Requires: pip install pytesseract pdf2image
import pytesseract
from pdf2image import convert_from_path

# Convert PDF to images
images = convert_from_path('scanned.pdf')

# OCR each page
text = ""
for i, image in enumerate(images):
    text += f"Page {i+1}:\n"
    text += pytesseract.image_to_string(image)
    text += "\n\n"

print(text)
```

### Add Watermark
```python
from pypdf import PdfReader, PdfWriter

# Create watermark (or load existing)
watermark = PdfReader("watermark.pdf").pages[0]

# Apply to all pages
reader = PdfReader("document.pdf")
writer = PdfWriter()

for page in reader.pages:
    page.merge_page(watermark)
    writer.add_page(page)

with open("watermarked.pdf", "wb") as output:
    writer.write(output)
```

### Extract Images
```bash
# Using pdfimages (poppler-utils)
pdfimages -j input.pdf output_prefix

# This extracts all images as output_prefix-000.jpg, output_prefix-001.jpg, etc.
```

### Password Protection
```python
from pypdf import PdfReader, PdfWriter

reader = PdfReader("input.pdf")
writer = PdfWriter()

for page in reader.pages:
    writer.add_page(page)

# Add password
writer.encrypt("userpassword", "ownerpassword")

with open("encrypted.pdf", "wb") as output:
    writer.write(output)
```

## Quick Reference

| Task | Best Tool | Command/Code |
|------|-----------|--------------|
| Merge PDFs | pypdf | `writer.add_page(page)` |
| Split PDFs | pypdf | One page per file |
| Extract text | pdfplumber | `page.extract_text()` |
| Extract tables | pdfplumber | `page.extract_tables()` |
| Create PDFs | reportlab | Canvas or Platypus |
| Command line merge | qpdf | `qpdf --empty --pages ...` |
| OCR scanned PDFs | pytesseract | Convert to image first |
| Fill PDF forms | pdf-lib or pypdf (see FORMS.md) | See FORMS.md |

## Next Steps

- For advanced pypdfium2 usage, see REFERENCE.md
- For JavaScript libraries (pdf-lib), see REFERENCE.md
- If you need to fill out a PDF form, follow the instructions in FORMS.md
- For troubleshooting guides, see REFERENCE.md
