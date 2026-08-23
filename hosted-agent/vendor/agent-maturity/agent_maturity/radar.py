#!/usr/bin/env python3
"""Render the maturity radar as inline SVG.

Standard library only. The SVG produced here is the single source of truth for
both the HTML report and the PNG snapshot, so the two can never disagree.

    python <skill-root>/scripts/render_radar.py <session-dir>/assessment.json --out <session-dir>/radar.svg

What the chart shows, and why:

* **Solid polygon** - the staged floor, min(sub-dimension levels) per pillar.
  This is the project's conservative diagnostic, not an official Microsoft
  pillar score.
* **Light outline** - the mean per pillar. The gap between the two polygons is
  the finding: it shows where unevenness is holding a pillar back.
* **Blue overlay** - one Responsible AI-bearing indicator per pillar, aligned
  to the same five axes. This preserves where trust lags instead of collapsing
  five values into one circular average.
* **Dashed spoke** - that pillar's floor is set by a dimension the customer
  asserted but did not evidence. Read that axis with suspicion.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys

R_MIN, R_MAX = 40.0, 180.0
LEVELS = [100, 200, 300, 400, 500]

# Copied verbatim from the Clawpilot theme so a standalone .svg renders and
# rasterizes correctly. When the SVG is inlined into the report the page's own
# :root wins and these are never applied.
STANDALONE_THEME = """
  :root{--cp-bg:#f7f4ef;--cp-surface:#ffffff;--cp-border:#dedede;
  --cp-border-strong:#919191;--cp-text:#242424;--cp-text-muted:#5c5c5c;
  --cp-accent:#b11f4b;--cp-accent-soft:rgba(177,31,75,0.08);
  --cp-warning:#f59e0b;--cp-link:#0078d4;}
"""

CHART_CSS = """
  .amr-bg{fill:var(--cp-bg)}
  .amr-grid{fill:none;stroke:var(--cp-border);stroke-width:1}
  .amr-grid-outer{fill:none;stroke:var(--cp-border-strong);stroke-width:1.25}
  .amr-spoke{stroke:var(--cp-border-strong);stroke-width:1}
  .amr-spoke-weak{stroke:var(--cp-warning);stroke-width:1.5;stroke-dasharray:5 4}
  .amr-rai{fill:var(--cp-link);fill-opacity:.10;stroke:var(--cp-link);stroke-width:1.75;stroke-dasharray:4 3}
  .amr-rai-dot{fill:var(--cp-bg);stroke:var(--cp-link);stroke-width:1.75}
  .amr-mean{fill:none;stroke:var(--cp-accent);stroke-width:1.5;stroke-dasharray:6 4;opacity:.7}
  .amr-staged{fill:var(--cp-accent);fill-opacity:.20;stroke:var(--cp-accent);stroke-width:2.5}
  .amr-dot{fill:var(--cp-accent)}
  .amr-dot-hollow{fill:var(--cp-bg);stroke:var(--cp-accent);stroke-width:2}
  .amr-axis{fill:var(--cp-text);font-size:13px;font-weight:600}
  .amr-axis-sub{fill:var(--cp-text-muted);font-size:11px}
  .amr-ring{fill:var(--cp-text-muted);font-size:9.5px;opacity:.85}
  .amr-legend{fill:var(--cp-text-muted);font-size:11px}
  .amr text{font-family:"Segoe UI",Aptos,Calibri,-apple-system,BlinkMacSystemFont,sans-serif}
"""


LEGEND = {
    "en": [
        "solid = project floor &#183; dashed outline = project mean",
        "blue overlay = Responsible AI profile &#183; amber spoke = unevidenced floor",
    ],
    "zh": [
        "\u5b9e\u5fc3 = \u9879\u76ee\u5e95\u7ebf &#183; \u865a\u7ebf\u8f6e\u5ed3 = \u9879\u76ee\u5747\u503c",
        "\u84dd\u8272\u591a\u8fb9\u5f62 = \u8d1f\u8d23\u4efb AI \u6a2a\u8d2f\u5c42 &#183; \u7425\u73c0\u8272\u8f74 = \u5e95\u7ebf\u65e0\u8bc1\u636e",
    ],
}


def r_of(level: float) -> float:
    return R_MIN + (level - 100.0) / 400.0 * (R_MAX - R_MIN)


def point(cx, cy, radius, i, n):
    angle = -math.pi / 2 + 2 * math.pi * i / n
    return cx + radius * math.cos(angle), cy + radius * math.sin(angle)


def poly(cx, cy, radii, n):
    return " ".join(f"{x:.1f},{y:.1f}" for x, y in (point(cx, cy, r, i, n) for i, r in enumerate(radii)))


def ring(cx, cy, radius, n):
    return poly(cx, cy, [radius] * n, n)


def esc(text):
    return (str(text).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace('"', "&quot;"))


def _label_anchor(i, n):
    x, _ = point(0, 0, 1, i, n)
    if abs(x) < 0.15:
        return "middle"
    return "start" if x > 0 else "end"


def short_name(name, lang, limit=22):
    """Axis labels must fit beside the chart. Prefer the part before a colon."""
    text = name.get(lang, name["en"]).split(":")[0].strip()
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "\u2026"


def radar_svg(assessment, lang="en", standalone=False, width=800, height=570):
    """Main five-axis radar."""
    pillars = assessment["pillars"]
    n = len(pillars)
    cx, cy = width / 2, height / 2 - 16

    staged = [r_of(p["staged"]) for p in pillars]
    means = [r_of(p["mean"]) for p in pillars]

    # A pillar's floor is weakly evidenced when the dimension that sets it was
    # not backed by a named artifact.
    weak = []
    for p in pillars:
        floor_dims = [d for d in p["dimensions"] if d["level"] == p["staged"]]
        weak.append(any(d["confidence"] != "evidenced" for d in floor_dims))

    rai = assessment["rai"]
    rai_radii = [r_of(item["level"]) for item in rai["profile"]]

    out = [
        f'<svg class="amr" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" '
        f'width="{width}" height="{height}" role="img" aria-label="Agentic AI maturity radar">',
        f"<style>{STANDALONE_THEME if standalone else ''}{CHART_CSS}</style>",
    ]
    if standalone:
        out.append(f'<rect class="amr-bg" x="0" y="0" width="{width}" height="{height}"/>')

    for lv in LEVELS:
        cls = "amr-grid-outer" if lv == 500 else "amr-grid"
        out.append(f'<polygon class="{cls}" points="{ring(cx, cy, r_of(lv), n)}"/>')
        out.append(f'<text class="amr-ring" x="{cx + 5:.1f}" y="{cy - r_of(lv) + 12:.1f}">{lv}</text>')

    for i in range(n):
        x, y = point(cx, cy, R_MAX, i, n)
        cls = "amr-spoke-weak" if weak[i] else "amr-spoke"
        out.append(f'<line class="{cls}" x1="{cx:.1f}" y1="{cy:.1f}" x2="{x:.1f}" y2="{y:.1f}"/>')

    out.append(f'<polygon class="amr-mean" points="{poly(cx, cy, means, n)}"/>')
    out.append(f'<polygon class="amr-staged" points="{poly(cx, cy, staged, n)}"/>')

    for i, p in enumerate(pillars):
        x, y = point(cx, cy, staged[i], i, n)
        cls = "amr-dot-hollow" if weak[i] else "amr-dot"
        out.append(f'<circle class="{cls}" cx="{x:.1f}" cy="{y:.1f}" r="4.5"/>')

        lx, ly = point(cx, cy, R_MAX + 26, i, n)
        anchor = _label_anchor(i, n)
        out.append(
            f'<text class="amr-axis" x="{lx:.1f}" y="{ly:.1f}" text-anchor="{anchor}">'
            f'{esc(p["id"])} &#183; {esc(short_name(p["name"], lang, 26))}</text>'
        )
        out.append(
            f'<text class="amr-axis-sub" x="{lx:.1f}" y="{ly + 15:.1f}" text-anchor="{anchor}">'
            f'{p["staged"]} / {p["mean"]}</text>'
        )

    out.append(f'<polygon class="amr-rai" points="{poly(cx, cy, rai_radii, n)}"/>')
    for i, radius in enumerate(rai_radii):
        x, y = point(cx, cy, radius, i, n)
        out.append(f'<circle class="amr-rai-dot" cx="{x:.1f}" cy="{y:.1f}" r="3.25"/>')

    legend = LEGEND.get(lang, LEGEND["en"])
    out.append(
        f'<text class="amr-legend" x="{cx:.1f}" y="{height - 26}" text-anchor="middle">{legend[0]}</text>'
    )
    out.append(
        f'<text class="amr-legend" x="{cx:.1f}" y="{height - 10}" text-anchor="middle">{legend[1]}</text>'
    )
    out.append("</svg>")
    return "\n".join(out)


def sub_radar_svg(pillar, lang="en", standalone=False, width=340, height=290):
    """Three-axis drill-down radar for one pillar."""
    dims = pillar["dimensions"]
    n = len(dims)
    cx, cy = width / 2, height / 2
    scale = 0.58
    r_min, r_max = R_MIN * scale, R_MAX * scale

    def rr(level):
        return r_min + (level - 100.0) / 400.0 * (r_max - r_min)

    radii = [rr(d["level"]) for d in dims]
    out = [
        f'<svg class="amr" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" '
        f'width="{width}" height="{height}" role="img" aria-label="{esc(pillar["id"])} drill-down">',
        f"<style>{STANDALONE_THEME if standalone else ''}{CHART_CSS}</style>",
    ]
    if standalone:
        out.append(f'<rect class="amr-bg" x="0" y="0" width="{width}" height="{height}"/>')
    for lv in LEVELS:
        cls = "amr-grid-outer" if lv == 500 else "amr-grid"
        out.append(f'<polygon class="{cls}" points="{ring(cx, cy, rr(lv), n)}"/>')
    for i, d in enumerate(dims):
        x, y = point(cx, cy, r_max, i, n)
        cls = "amr-spoke-weak" if d["confidence"] != "evidenced" else "amr-spoke"
        out.append(f'<line class="{cls}" x1="{cx:.1f}" y1="{cy:.1f}" x2="{x:.1f}" y2="{y:.1f}"/>')
    out.append(f'<polygon class="amr-staged" points="{poly(cx, cy, radii, n)}"/>')
    for i, d in enumerate(dims):
        x, y = point(cx, cy, radii[i], i, n)
        cls = "amr-dot-hollow" if d["confidence"] != "evidenced" else "amr-dot"
        out.append(f'<circle class="{cls}" cx="{x:.1f}" cy="{y:.1f}" r="3.5"/>')
        lx, ly = point(cx, cy, r_max + 20, i, n)
        out.append(
            f'<text class="amr-axis-sub" x="{lx:.1f}" y="{ly:.1f}" text-anchor="{_label_anchor(i, n)}">'
            f'{esc(d["id"])} &#183; {d["level"]}</text>'
        )
    out.append("</svg>")
    return "\n".join(out)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("assessment")
    ap.add_argument("--out", required=True)
    ap.add_argument("--lang", default=None, help="en or zh; defaults to the engagement language")
    args = ap.parse_args(argv)

    with open(args.assessment, encoding="utf-8") as fh:
        assessment = json.load(fh)
    lang = args.lang or assessment.get("engagement", {}).get("language", "en")

    svg = radar_svg(assessment, lang=lang, standalone=True)
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(svg + "\n")
    print(f"wrote {args.out} ({len(svg)} bytes, {len(assessment['pillars'])} axes, lang={lang})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
