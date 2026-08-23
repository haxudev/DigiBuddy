---
name: agent-maturity-report
description: Present, re-render, translate or explain an agent maturity assessment that has already been scored. Use when an assessment.json exists and the request is to rebuild the HTML report or radar chart, produce the Chinese or English version, export a PNG for a deck, write up the debrief or executive summary, or answer a customer who is challenging a capped score and wants to know why they were marked down.
license: MIT
---

# Debrief and re-render a maturity assessment

The interview is over and `assessment.json` exists. This skill turns it into
something a customer reads, and defends it when they push back.

If you are still interviewing, use `agent-maturity-assess` instead.

## Re-rendering

Everything downstream reads `assessment.json` and nothing else, so re-rendering
never touches the interview or the scoring.

`maturity_render_report`, with `session_dir` or an explicit `assessment` path:

- `formats: ["html"]` - the self-contained interactive report
- `formats: ["svg"]` - the standalone radar chart
- `formats: ["png"]` - a raster for a deck, at 2x device scale
- `lang: "zh"` or `"en"` - defaults to the engagement language

The PNG is rasterized from the same SVG the HTML embeds, so the two can never
disagree. It needs a Chromium-family browser; if none is found the PNG is
skipped, a warning comes back, and the HTML and SVG are still written.

The HTML obeys the OneDrive/SharePoint sandbox rules - no external resources, no
network calls, no storage - so it renders offline and is safe to hand over or
open from a shared link.

Console equivalent:

```bash
agent-maturity render --session-dir <dir> --formats html svg png --lang zh
```

## The narrative

Read `report-template.md` before presenting. In short:

**Open with the binding constraint, not the average.** The lowest sub-dimension
is what actually stops the next agent reaching production. An average of 260
tells a customer nothing they can act on; "your governance floor is 100, and
that is what will stop you" does.

**Show the gap between the floor and the mean.** A wide spread means uneven
capability - usually one team that has figured it out and an organization that
has not. That is a different problem from being uniformly early, and it has a
different fix.

**Name the Responsible AI overlay explicitly.** RAI is not a sixth axis because
Microsoft states it is embedded across all dimensions. Five sub-dimensions carry
their pillar's RAI characteristic; when that overlay lags the capability
profile, the organization is building faster than it is governing. Say so.

**Close on the roadmap.** Each item is either an evidence-closure step (the
capability may exist but is unproven) or a capability step (it does not exist
yet). Do not let a customer spend money building something they may already have
and simply cannot show you.

## When a customer challenges a score

This is the moment the engagement is won or lost. Do not defend the number; show
the rule.

`maturity_explain_score` with a `dimension` returns the exact sentence, already
localized: "claimed 400, scored 200, because ...". Omit `dimension` for all
fifteen.

The three reasons a score was lowered, and only these three:

| Code | What happened |
| --- | --- |
| `no_artifact` | Claimed 300 or above but named no supporting artifact, capped at 200 |
| `probe_failed` | Claimed 400 or above but did not pass the disconfirming probe, capped at 300 |
| `pulse_ceiling` | Pulse does not ask the disconfirming probe, so it cannot establish a result above 300 |

The gate **only ever lowers**. If a customer believes a cap is wrong, the fix is
evidence, not argument: name the artifact, or give the concrete instance the
probe asked for, and re-run that sub-dimension. Offer that. It is a better
outcome than a number they do not believe.

Three things to say plainly when asked:

- The five-pillar profile is the official model output. The floor, the mean and
  the RAI overlay are this project's diagnostic method, not a Microsoft scoring
  algorithm.
- There is no comparative dataset. This cannot tell them how they compare to
  their peers, and any tool that claims to on this basis is guessing.
- This is one conversation with one group of people at one moment. It is not an
  audit and nothing was verified against a system.

## The written summary

`report-template.md` holds the skeleton. Keep it to one page: where they are,
the binding constraint, the uneven bits, the three things to do next, and what
would change the answer. Quote the customer verbatim - the report already
carries their words, and quotes survive a disagreement that a paraphrase does
not.

## Files

The reference documents live in the `agent-maturity-assess` skill under
`references/`, and are served as MCP resources (`maturity://references/...`)
when this pack is loaded as an MCP server. The two that matter here are
`report-template.md` and `scoring-rubric.md`.
