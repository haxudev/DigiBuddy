---
name: ppt-outline
description: >-
  Generate a PPT slide outline in Markdown (xxx-outline.md) from user-provided sources such as this repo,
  local files, pasted context, or fetched web pages. Use when asked to create a slide deck outline / PPT
  structure / "大纲"，with strict formatting: use a single-line `---` page break between slides, and every
  slide must contain exactly two parts: (1) on-slide content (title + concise bullets/short description),
  (2) a detailed per-slide image description for image generation.
---

# Ppt Outline

## Overview

Turn mixed sources (repo/files/web/context) into a slide-by-slide PPT outline file.
The output is ready for downstream “markdown → ppt” or “markdown → image prompt → ppt” pipelines.

## Output Contract (must follow)

- Output: a single Markdown file named `xxx-outline.md`.
	- If user provides a target path/name, follow it.
	- Otherwise default to `outlines/<topic>-ppt-outline-YYYYMMDD.md`.
- Slide/page separator: `---` on its own line between slides.
- Every slide must contain exactly two parts:
	1) **页面内容**: what appears on the slide (title + concise bullets / short description)
	2) **配图描述**: detailed image description for image generation
- Keep on-slide text short:
	- Prefer 3–6 bullets
	- Prefer 6–18 Chinese characters per bullet (or similar brevity in other languages)
	- Avoid long paragraphs
- Do not add speaker notes / talk track unless user explicitly requests.

## Workflow

### Step 0 — Capture parameters (ask only if missing)

Ask up to 3 questions total when unclear:

- Deck goal: persuade / explain / report / training
- Audience: executives / product / engineering / sales / mixed
- Slide count or timebox: e.g., 8/10/12 pages
- Language: zh-CN default

If user already specified constraints, do not ask again.

### Step 1 — Collect and prioritize sources

Use only the sources the user points to (do not invent new sources):

- **Repo context**: read relevant `README.md`, `docs/`, `requirements/`, `workflows/`, `generated/<name>/workflow.yaml`, or files the user mentioned.
- **Local files**: outlines, inputs, reports, or any referenced docs.
- **Web pages**: fetch only URLs provided by the user.
- **Pasted context**: treat as authoritative.

Then extract:

- Key messages (3–6)
- Supporting facts/examples (only those that fit slides)
- Logical story arc (problem → approach → evidence → impact → next steps)

### Step 2 — Build the slide storyline

Default storyline (adjust to user intent):

1) Title / context
2) Problem / opportunity
3) Approach / framework
4) 2–5 core content slides (group by themes)
5) Risks / constraints (optional)
6) Summary / next steps

### Step 3 — Write each slide with strict template

For each slide:

- Provide a clear slide title
- Write concise bullets that can be pasted into PPT directly
- Write a detailed “配图描述” that matches the slide message and is usable as an image prompt

### Step 4 — Quality gate (self-check)

- Every slide has `页面内容` and `配图描述`
- Every slide is separated by `---`
- No slide is overly verbose
- Image descriptions are specific (subject + scene + composition + style + constraints)

## Required Slide Template (copy/paste)

Use this exact structure per slide. Use `---` only **between** slides (do not add a leading separator before slide 1).

Minimal example (2 slides):

## 1. <标题>

### 页面内容
- ...

### 配图描述
- ...

---

## 2. <标题>

### 页面内容
- ...

### 配图描述
- ...

Per-slide template:

## <页码>. <标题>

### 页面内容
- <bullet 1>
- <bullet 2>
- <bullet 3>

### 配图描述
- 画面主体：
- 场景/环境：
- 构图/镜头：
- 风格/质感：
- 关键细节：
- 画面文字（如需）：
- 避免事项（可选）：

## Reference

- If you need a longer example or field guidance for image prompts, read: `references/api_reference.md`.