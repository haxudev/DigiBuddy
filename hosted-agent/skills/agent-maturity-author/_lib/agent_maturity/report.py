#!/usr/bin/env python3
"""Build the self-contained interactive HTML report.

Standard library only. The output obeys the OneDrive/SharePoint sandbox rules
because the file is meant to be handed to a customer and opened anywhere:

* no external resources, no `<script src>`, no `<link>`, no `@import`
* every script inline and non-module, no `fetch`/`XMLHttpRequest`
* no localStorage/sessionStorage - the open pillar is persisted in location.hash
* no top-level navigation, so Learn URLs are rendered as text, not anchors
* handlers attached with addEventListener, never inline `on*=` with data

    python <skill-root>/scripts/build_report.py <session-dir>/assessment.json --out <session-dir>/report.html
"""

from __future__ import annotations

import argparse
import json
import os
import sys

from .radar import radar_svg, sub_radar_svg, esc, short_name

THEME_SCRIPT = """
  (() => {
    const param = new URLSearchParams(window.location.search).get("scoutTheme");
    const theme =
      param || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    document.documentElement.setAttribute("data-theme", theme);
  })();
"""

THEME_CSS = """
:root {
  color-scheme: light;
  --cp-bg: #f7f4ef;
  --cp-bg-elevated: #fcfbf8;
  --cp-surface: #ffffff;
  --cp-surface-soft: #f5f5f5;
  --cp-border: #dedede;
  --cp-border-strong: #919191;
  --cp-text: #242424;
  --cp-text-muted: #5c5c5c;
  --cp-text-soft: #6f6f6f;
  --cp-accent: #b11f4b;
  --cp-accent-hover: #9a1a41;
  --cp-accent-soft: rgba(177, 31, 75, 0.08);
  --cp-accent-fg: #ffffff;
  --cp-success: #16a34a;
  --cp-danger: #dc2626;
  --cp-warning: #f59e0b;
  --cp-link: #0078d4;
  --cp-shadow: 0 18px 48px rgba(0, 0, 0, 0.12);
  --cp-overlay: rgba(255, 255, 255, 0.8);
  --cp-panel: rgba(255, 255, 255, 0.86);
  --cp-panel-strong: rgba(255, 255, 255, 0.96);
  --cp-sheen: rgba(255, 255, 255, 0.55);
  --cp-highlight: rgba(177, 31, 75, 0.12);
}
html[data-theme="dark"] {
  color-scheme: dark;
  --cp-bg: #3d3b3a;
  --cp-bg-elevated: #343231;
  --cp-surface: #292929;
  --cp-surface-soft: #2e2e2e;
  --cp-border: #474747;
  --cp-border-strong: #5f5f5f;
  --cp-text: #dedede;
  --cp-text-muted: #919191;
  --cp-text-soft: #b0b0b0;
  --cp-accent: #fd8ea1;
  --cp-accent-hover: #fb7b91;
  --cp-accent-soft: rgba(253, 142, 161, 0.14);
  --cp-accent-fg: #1a1a1a;
  --cp-success: #4ade80;
  --cp-danger: #f87171;
  --cp-warning: #fbbf24;
  --cp-link: #4da6ff;
  --cp-shadow: 0 18px 48px rgba(0, 0, 0, 0.32);
  --cp-overlay: rgba(41, 41, 41, 0.88);
  --cp-panel: rgba(41, 41, 41, 0.72);
  --cp-panel-strong: rgba(41, 41, 41, 0.96);
  --cp-sheen: rgba(255, 255, 255, 0.04);
  --cp-highlight: rgba(253, 142, 161, 0.12);
}
"""

COMPONENT_CSS = """
* { box-sizing: border-box; }
body {
  margin: 0; padding: 32px 20px 64px;
  background: var(--cp-bg); color: var(--cp-text);
  font-family: "Segoe UI", Aptos, Calibri, -apple-system, BlinkMacSystemFont, sans-serif;
  line-height: 1.55;
}
main { max-width: 1080px; margin: 0 auto; }
h1 { font-size: 1.75rem; margin: 0 0 4px; }
h2 { font-size: 1.15rem; margin: 0 0 12px; }
h3 { font-size: .95rem; margin: 0 0 6px; }
.sub { color: var(--cp-text-muted); font-size: .9rem; margin: 0; }
.card {
  background: var(--cp-surface); border: 1px solid var(--cp-border);
  border-radius: 16px; padding: 20px 22px; margin-bottom: 18px;
  box-shadow: 0 0 2px rgba(0,0,0,0.12), 0 1px 2px rgba(0,0,0,0.14);
}
.grid { display: grid; gap: 18px; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); }
.kpi { border: 1px solid var(--cp-border); border-radius: 10px; padding: 14px 16px; background: var(--cp-surface-soft); }
.kpi .v { font-size: 1.9rem; font-weight: 650; color: var(--cp-accent); line-height: 1.1; }
.kpi .l { font-size: .78rem; color: var(--cp-text-muted); text-transform: uppercase; letter-spacing: .04em; }
.kpi .n { font-size: .85rem; color: var(--cp-text-soft); margin-top: 6px; }
.radar-wrap { display: flex; flex-wrap: wrap; gap: 24px; align-items: flex-start; }
.radar-wrap svg { max-width: 100%; height: auto; }
.readout { flex: 1 1 280px; min-width: 260px; }
.readout p { margin: 0 0 10px; font-size: .92rem; }
.tabs { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
.tab {
  font: inherit; font-size: .86rem; cursor: pointer;
  background: var(--cp-surface-soft); color: var(--cp-text);
  border: 1px solid var(--cp-border); border-radius: 0.625rem; padding: 8px 14px;
}
.tab[aria-selected="true"] { background: var(--cp-accent); color: var(--cp-accent-fg); border-color: var(--cp-accent); }
.panel[hidden] { display: none; }
.panel-body { display: flex; flex-wrap: wrap; gap: 22px; align-items: flex-start; }
.panel-body .dims { flex: 1 1 420px; min-width: 300px; }
.dim { border-top: 1px solid var(--cp-border); padding: 12px 0; }
.dim:first-child { border-top: 0; }
.dim-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.dim-id { font-family: Consolas, "Courier New", Courier, monospace; color: var(--cp-text-muted); font-size: .8rem; }
.dim-name { font-weight: 600; }
.lvl { font-weight: 650; color: var(--cp-accent); }
.chip {
  font-size: .72rem; padding: 2px 8px; border-radius: 999px;
  border: 1px solid var(--cp-border-strong); color: var(--cp-text-muted);
}
.chip.evidenced { border-color: var(--cp-success); color: var(--cp-success); }
.chip.asserted { border-color: var(--cp-warning); color: var(--cp-warning); }
.chip.inferred { border-color: var(--cp-border-strong); }
.chip.rai { border-color: var(--cp-link); color: var(--cp-link); }
.cap { font-size: .82rem; color: var(--cp-warning); margin: 6px 0 0; }
.quote { font-size: .86rem; color: var(--cp-text-soft); margin: 6px 0 0; padding-left: 12px; border-left: 2px solid var(--cp-border); }
.ev { font-size: .82rem; color: var(--cp-text-muted); margin: 4px 0 0; }
.anchor { font-size: .84rem; color: var(--cp-text-muted); margin: 6px 0 0; }
ol.road { margin: 0; padding-left: 20px; }
ol.road li { margin-bottom: 16px; }
ol.road .why { font-size: .82rem; color: var(--cp-text-muted); }
ol.road .step { font-size: .88rem; margin-top: 6px; }
ol.road .step b { color: var(--cp-accent); }
footer.method { color: var(--cp-text-muted); font-size: .82rem; }
footer.method code { font-family: Consolas, "Courier New", Courier, monospace; font-size: .78rem; word-break: break-all; }
"""

TAB_SCRIPT = """
  (() => {
    const tabs = Array.prototype.slice.call(document.querySelectorAll(".tab"));
    const panels = Array.prototype.slice.call(document.querySelectorAll(".panel"));
    function show(id) {
      tabs.forEach(function (t) { t.setAttribute("aria-selected", String(t.dataset.pillar === id)); });
      panels.forEach(function (p) { p.hidden = p.dataset.pillar !== id; });
      try { history.replaceState(null, "", "#" + id); } catch (e) { window.location.hash = id; }
    }
    tabs.forEach(function (t) {
      t.addEventListener("click", function () { show(t.dataset.pillar); });
    });
    const initial = (window.location.hash || "").replace("#", "");
    show(tabs.some(function (t) { return t.dataset.pillar === initial; }) ? initial : tabs[0].dataset.pillar);
  })();
"""

L = {
    "en": {
        "title": "Agentic AI adoption maturity assessment",
        "overall": "Project diagnostic floor",
        "staged": "conservative floor",
        "mean": "mean",
        "binding": "Binding constraint",
        "rai": "Responsible AI overlay",
        "rai_lags": "Trust lags in pillars",
        "rai_ok": "Trust is keeping pace with capability",
        "evidence": "Evidence quality",
        "readout": "How to read this chart",
        "pillars": "Pillar detail",
        "roadmap": "What to do next",
        "method": "Method and sources",
        "claimed": "claimed",
        "scored": "scored",
        "today": "Today",
        "next": "Next action",
        "participants": "Participants",
        "tier": "Depth",
        "of": "of",
        "dims_evidenced": "sub-dimensions backed by a named artifact",
        "deep_probe": "Deep probe",
    },
    "zh": {
        "title": "Agentic AI 采用成熟度评估",
        "overall": "项目诊断底线",
        "staged": "保守底线",
        "mean": "均值",
        "binding": "制约瓶颈",
        "rai": "负责任 AI 横贯层",
        "rai_lags": "信任落后的支柱",
        "rai_ok": "信任与能力同步",
        "evidence": "证据质量",
        "readout": "如何读这张图",
        "pillars": "支柱明细",
        "roadmap": "下一步做什么",
        "method": "方法与来源",
        "claimed": "自述",
        "scored": "判定",
        "today": "今天的样子",
        "next": "下一步行动",
        "participants": "参与人",
        "tier": "深度",
        "of": "/",
        "dims_evidenced": "个子维度有具名制品支撑",
        "deep_probe": "Deep 二次探针",
    },
}

READOUT = {
    "en": [
        "The <b>solid shape</b> is this project's conservative pillar floor. Microsoft defines the five pillars and levels; the minimum aggregation is a project-authored diagnostic, not an official Microsoft score.",
        "The <b>dashed outline</b> is the project-computed mean. Where it sits outside the solid shape, that pillar has uneven capability; the gap is diagnostic context, not an official score.",
        "The <b>blue polygon</b> preserves one Responsible AI-bearing indicator per pillar. A blue vertex inside that pillar's other capability indicates where trust is lagging.",
        "An <b>amber dashed spoke</b> means that pillar's floor rests on something the organization asserted but did not evidence. Read that axis with suspicion.",
    ],
    "zh": [
        "<b>实心多边形</b>是本项目计算的保守支柱底线。微软定义了五支柱和五级；min 聚合是项目自定义诊断方法，不是微软官方评分。",
        "<b>虚线轮廓</b>是本项目计算的均值。它外扩于实心多边形时，表示该支柱能力不均衡；这个落差是诊断背景，不是官方分数。",
        "<b>蓝色多边形</b>保留了每个支柱各自的一个「承载 RAI」指标。某个蓝色顶点落在该支柱其他能力以内，说明该处信任落后。",
        "<b>琥珀色虚线轴</b>表示该支柱的底线建立在对方口头声称、但未拿出证据的事情上。读这根轴时请保留怀疑。",
    ],
}


def chips(d, t):
    out = [f'<span class="chip {d["confidence"]}">{d["confidence"]}</span>']
    if d["rai_bearing"]:
        out.append('<span class="chip rai">RAI</span>')
    return " ".join(out)


def dim_html(d, t, lang):
    parts = [
        '<div class="dim">',
        '<div class="dim-head">',
        f'<span class="dim-id">{esc(d["id"])}</span>',
        f'<span class="dim-name">{esc(d["name"].get(lang, d["name"]["en"]))}</span>',
        f'<span class="lvl">{d["level"]}</span>',
        chips(d, t),
        "</div>",
    ]
    if d["capped"]:
        parts.append(
            f'<p class="cap">{t["claimed"]} {d["claimed"]} &#8594; {t["scored"]} {d["level"]} &#183; '
            f'{esc(d["cap_reason"].get(lang, d["cap_reason"]["en"]))}</p>'
        )
    if d.get("quote"):
        parts.append(f'<p class="quote">&#8220;{esc(d["quote"])}&#8221;</p>')
    if d.get("evidence"):
        parts.append(f'<p class="ev">&#9679; {esc(d["evidence"])}</p>')
    if d.get("probe2_answer"):
        parts.append(
            f'<p class="ev">&#9679; {esc(t["deep_probe"])}: {esc(d["probe2_answer"])}</p>'
        )
    parts.append(
        f'<p class="anchor"><b>{t["today"]}:</b> {esc(d["current_anchor"].get(lang, d["current_anchor"]["en"]))}</p>'
    )
    parts.append("</div>")
    return "".join(parts)


def build(assessment, lang="en"):
    t = L.get(lang, L["en"])
    eng = assessment.get("engagement", {})
    f = assessment["findings"]
    rai = assessment["rai"]
    lagging_pillars = ", ".join(rai["lagging_pillars"])
    org = eng.get("organization", "Assessment")

    all_dims = [d for p in assessment["pillars"] for d in p["dimensions"]]
    n_dims = len(all_dims)
    n_ev = f["confidence_counts"].get("evidenced", 0)
    binding_ids = ", ".join(f["binding_constraint"]["dimensions"])

    head = [
        "<!DOCTYPE html>",
        f'<html lang="{lang}">',
        "<head>",
        '<meta charset="UTF-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        f"<title>{esc(org)} &#183; {esc(t['title'])}</title>",
        f"<script>{THEME_SCRIPT}</script>",
        f"<style>{THEME_CSS}{COMPONENT_CSS}</style>",
        "</head>",
        "<body><main>",
    ]

    body = [
        '<header class="card">',
        f"<h1>{esc(t['title'])}</h1>",
        f'<p class="sub"><b>{esc(org)}</b>'
        + (f" &#183; {esc(eng['sector'])}" if eng.get("sector") else "")
        + (f" &#183; {esc(eng['date'])}" if eng.get("date") else "")
        + (f" &#183; {esc(t['tier'])}: {esc(eng['tier'])}" if eng.get("tier") else "")
        + "</p>",
    ]
    if eng.get("participants"):
        body.append(
            f'<p class="sub">{esc(t["participants"])}: {esc(", ".join(eng["participants"]))}</p>'
        )
    body.append("</header>")

    body += [
        '<section class="card"><div class="grid">',
        f'<div class="kpi"><div class="l">{esc(t["overall"])}</div>'
        f'<div class="v">{assessment["overall"]["staged"]}</div>'
        f'<div class="n">{esc(t["staged"])} &#183; {esc(t["mean"])} {assessment["overall"]["mean"]}</div></div>',
        f'<div class="kpi"><div class="l">{esc(t["binding"])}</div>'
        f'<div class="v">{esc(binding_ids)}</div>'
        f'<div class="n">{f["binding_constraint"]["level"]}</div></div>',
        f'<div class="kpi"><div class="l">{esc(t["rai"])}</div>'
        f'<div class="v">{rai["staged"]}</div>'
        f'<div class="n">{esc(t["rai_lags"] + ": " + lagging_pillars if lagging_pillars else t["rai_ok"])}</div></div>',
        f'<div class="kpi"><div class="l">{esc(t["evidence"])}</div>'
        f'<div class="v">{n_ev} {esc(t["of"])} {n_dims}</div>'
        f'<div class="n">{esc(t["dims_evidenced"])}</div></div>',
        "</div></section>",
    ]

    body += [
        '<section class="card"><div class="radar-wrap">',
        radar_svg(assessment, lang=lang, standalone=False),
        f'<div class="readout"><h2>{esc(t["readout"])}</h2>',
        "".join(f"<p>{line}</p>" for line in READOUT.get(lang, READOUT["en"])),
        "</div></div></section>",
    ]

    body.append(f'<section class="card"><h2>{esc(t["pillars"])}</h2><div class="tabs">')
    for p in assessment["pillars"]:
        body.append(
            f'<button class="tab" type="button" role="tab" data-pillar="{esc(p["id"])}" '
            f'aria-selected="false">{esc(p["id"])} &#183; {esc(short_name(p["name"], lang, 30))} '
            f'&#183; {p["staged"]}</button>'
        )
    body.append("</div>")
    for p in assessment["pillars"]:
        body += [
            f'<div class="panel" data-pillar="{esc(p["id"])}" hidden><div class="panel-body">',
            f"<div>{sub_radar_svg(p, lang=lang, standalone=False)}"
            f'<p class="sub" style="text-align:center">{esc(t["staged"])} {p["staged"]} &#183; '
            f'{esc(t["mean"])} {p["mean"]}</p></div>',
            '<div class="dims">',
            "".join(dim_html(d, t, lang) for d in p["dimensions"]),
            "</div></div></div>",
        ]
    body.append("</section>")

    body.append(f'<section class="card"><h2>{esc(t["roadmap"])}</h2><ol class="road">')
    for r in f["roadmap"]:
        body += [
            "<li>",
            f'<b>{esc(r["dimension"])} &#183; {esc(r["name"].get(lang, r["name"]["en"]))}</b> '
            f'<span class="lvl">{r["from"]} &#8594; {r["to"]}</span>',
            f'<div class="why">{esc(r["why_here"].get(lang, r["why_here"]["en"]))}</div>',
            f'<div class="step"><b>{esc(t["next"])}:</b> '
            f'{esc(r["next_action"].get(lang, r["next_action"]["en"]))}</div>',
            "</li>",
        ]
    body.append("</ol></section>")

    model = assessment["model"]
    method = {
        "en": (
            "Microsoft defines the five pillars, five levels and cross-cutting Responsible AI. "
            "This report uses a project-authored diagnostic floor and evidence gate: a claim of 300 or above "
            "with no named artifact is capped at 200, and a claim of 400 or above additionally "
            "requires passing a disconfirming probe or is capped at 300. Pulse omits that probe "
            "and is therefore a screening result capped at 300."
        ),
        "zh": (
            "\u5fae\u8f6f\u5b9a\u4e49\u4e86\u4e94\u652f\u67f1\u3001\u4e94\u7ea7\u4ee5\u53ca\u6a2a\u8d2f\u7684\u8d1f\u8d23\u4efb AI\u3002"
            "\u672c\u62a5\u544a\u4f7f\u7528\u9879\u76ee\u81ea\u5b9a\u4e49\u7684\u8bca\u65ad\u5e95\u7ebf\u4e0e\u8bc1\u636e\u95f8\u95e8\uff1a"
            "\u81ea\u8ff0 300 \u53ca\u4ee5\u4e0a\u4f46\u8bf4\u4e0d\u51fa\u5177\u540d\u5236\u54c1\u7684\uff0c\u5c01\u9876 200\uff1b"
            "\u81ea\u8ff0 400 \u53ca\u4ee5\u4e0a\u7684\u8fd8\u987b\u901a\u8fc7\u8bc1\u4f2a\u63a2\u9488\uff0c\u5426\u5219\u5c01\u9876 300\u3002"
            "Pulse \u4e0d\u63d0\u95ee\u8be5\u63a2\u9488\uff0c\u56e0\u6b64\u662f\u5c01\u9876 300 \u7684\u7b5b\u67e5\u7ed3\u679c\u3002"
        ),
    }
    retrieved = {"en": "retrieved", "zh": "\u53d6\u81ea"}
    gen = {"en": "Generated", "zh": "\u751f\u6210\u4e8e"}
    body += [
        f'<footer class="card method"><h2>{esc(t["method"])}</h2>',
        f'<p>{esc(model["name"])} &#183; {esc(retrieved.get(lang, retrieved["en"]))} '
        f'{esc(model["retrieved"])} &#183; <code>{esc(model["root"])}</code></p>',
        "<p>"
        + " &#183; ".join(f'{esc(p["id"])} <code>{esc(p["source"])}</code>' for p in assessment["pillars"])
        + "</p>",
        f'<p>{esc(method.get(lang, method["en"]))} '
        f'{esc(gen.get(lang, gen["en"]))} {esc(assessment["generated_at"])}.</p>',
        "</footer>",
    ]

    tail = ["</main>", f"<script>{TAB_SCRIPT}</script>", "</body></html>"]
    return "\n".join(head + body + tail)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("assessment")
    ap.add_argument("--out", required=True)
    ap.add_argument("--lang", default=None)
    args = ap.parse_args(argv)

    with open(args.assessment, encoding="utf-8") as fh:
        assessment = json.load(fh)
    lang = args.lang or assessment.get("engagement", {}).get("language", "en")

    html = build(assessment, lang=lang)
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(html)
    print(f"wrote {args.out} ({len(html)} bytes, lang={lang})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
