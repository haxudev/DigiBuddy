# Debrief and written summary

Read this before presenting the result or writing it up. The report is already
built; this is about what you say over it.

## The one rule

**Open with the binding constraint, never with the average — and call it the
project diagnostic floor, not Microsoft's overall score.**

"You're at 253 on average" is a number nobody can act on, and it invites an
argument about the arithmetic. "Everything you do is currently floored by one
thing, and here it is" is a conversation about what to do on Monday.

## Narrative order

Twenty minutes, in this order. It survives interruption because each step stands
alone.

1. **What we did.** Depth, who was in the room, how many questions, and that the
   answers came from them rather than from us. Thirty seconds. This is also
   where you say that a different room might have answered differently - it
   protects the result from the "well, *I* would have said" objection later.

2. **The binding constraint.** Name the dimension, read its current anchor back
   to them in their own words, and stop talking. Let them recognize themselves.
   This is the moment the assessment either lands or does not.

3. **The radar, read in one pass.** Microsoft defines the five pillar axes and
   five levels. The solid floor and dashed mean are project-authored diagnostics.
   The gap between them is where strong areas are being held back.
   Point at the widest gap and name the sub-dimension holding it down - it is in
   `findings.unevenness[].held_back_by`. Then the blue RAI overlay: if
   `rai.lags_capability` is true, say plainly that **trust is lagging
   capability**, and that this is the risk that shows up as an incident rather
   than as a slow quarter.

4. **Evidence quality.** "Nine of fifteen sub-dimensions were backed by
   something you could name." Then the capped ones, each as
   "you told us X, we scored Y, because we could not see Z". Frame these as the
   cheapest wins in the room, not as accusations: in most of them the capability
   plausibly exists and only the proof is missing, and proof is faster to build
   than capability.

5. **Three things to do next.** Take the top three roadmap items and no more.
   For `evidence-closure`, read `next_action`: close the proof gap rather than
   prescribing capability work. For `capability-step`, the next-level anchor is
   the target behavior and doubles as an acceptance criterion.

6. **What we did not assess.** Say it out loud: this is one conversation with
   one group of people at one moment. It is not an audit, there is no comparison
   against other organizations, and nothing here was verified against a system.

## Questions you will get, and the answers

**"Why are we a 200 when we said 400?"**
Read the two gate rules. Then offer the re-score: name the artifact now, and we
re-run it in front of you. This turns a defensive moment into a demonstration
that the method is mechanical rather than an opinion. See
`scoring-rubric.md` section 2.

**"Our technology is excellent, why is the pillar floor low?"**
The floor is this project's conservative diagnostic: it names the weakest
sub-dimension, while the dashed mean preserves the stronger areas. Microsoft
does not publish that aggregation; use it to discuss dependencies, not as an
official overall score.

**"How do we compare to our peers?"**
We do not know, and this tool has no comparative dataset. Anyone who tells you
otherwise is quoting an impression. What we can say is where you sit against
Microsoft's published model, and that is checkable against the source.

**"Who decided these questions?"**
Every sub-dimension traces to a named heading in a Microsoft Learn page, and
every anchor is that page's level descriptor rewritten in operational language.
The source URLs and retrieval date are in the report footer and in
`references/pillars.md`.

**"Can we re-run this in six months?"**
Yes, and it is worth doing. Keep the answers file. The comparison that matters
is not the headline number but which sub-dimensions moved and whether the
evidence tags moved from `asserted` to `evidenced`.

## Written summary skeleton

For the follow-up mail or the one-pager that goes to people who were not in the
room. Keep it to one screen; the HTML report carries the detail.

```
Subject: Agentic AI maturity assessment - <organization>, <date>

We assessed <organization> against Microsoft's Agentic AI adoption maturity
model on <date>, at <tier> depth, with <participants>.

Where you are
  Project diagnostic floor <staged>. The assessment is currently floored by
  <binding dimensions>, which today looks like: "<current anchor, quoted>".

What the chart says
  <Pillar> shows the widest gap between its floor (<staged>) and its mean
  (<mean>), held down by <held_back_by>. Closing that one sub-dimension lifts
  the whole pillar.
  [If rai.lags_capability] The Responsible AI overlay lags the non-RAI
  capability mean in pillars <lagging_pillars>.

What we could see
  <n> of <total> sub-dimensions were backed by a named artifact.
  <For each capped dimension> You described <claimed>; we scored <level>
  because <reason>. If the artifact exists, send it and we will re-score.

Three things to do next
  1. <dimension> <from> to <to> - <next_action>
  2. ...
  3. ...

Scope
  One conversation, one group, one moment. Not an audit, and not benchmarked
  against other organizations. Method and sources are in the attached report.

Attached: <organization>-agent-maturity.html (opens offline, no network needed)
```

## Handing over the files

- The HTML is self-contained and renders with no network access, so it can be
  mailed, put in OneDrive or SharePoint, or opened from a memory stick.
- The PNG is for slides and mail bodies. It is rasterized from the same SVG the
  report embeds, so it cannot disagree with the report.
- The answers file contains verbatim customer statements. Treat it with the
  confidentiality the engagement agreed, and do not circulate it with the report
  by reflex.
- Tell the user the full path of every file produced. A file they have to hunt
  for is a file they do not send.
