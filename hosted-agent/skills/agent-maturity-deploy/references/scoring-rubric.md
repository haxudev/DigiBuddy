# Scoring rubric

Read this before explaining a score to a customer, before changing any scoring
rule, and whenever a customer challenges a capped level. `agent-maturity validate`
and `agent_maturity.validation` are the machine-checkable form of everything below.

Microsoft publishes the five capability pillars, five maturity levels and
Responsible AI as a cross-cutting concern. Everything else in this file — the
15 sub-dimensions, evidence caps, floors, means, roadmap order and RAI overlay —
is this project's diagnostic method, not an official Microsoft scoring rule.

## 1. The anchor sets the level

The chosen Q-A anchor maps to exactly one level in 100-500. Nothing else feeds
the level - not tone, not how impressive the story was, not the consultant's
own read of the organization.

This is deliberate. Self-rating scales return flattery, and flattery handed to a
customer as a deliverable is worse than no assessment. Because the anchors are
Microsoft's own level descriptors rewritten as observable behavior, the customer
is choosing a description of their Tuesday, not a score.

## 2. The project-authored evidence gate only ever lowers

| Condition | Cap |
| --- | --- |
| Claimed 300 or above, no named artifact in `evidence` | 200 |
| Claimed 400 or above, `qc_passed` is not `true` | 300 |
| Pulse claim of 400 or above | 300, because Pulse does not ask Q-C |

Both rules are evaluated and the lowest result wins. A claim of 400 with no
artifact and no passed probe therefore scores **200**, not 300.

The gate can never raise a level. `agent-maturity validate` enforces
`level <= claimed` and fails the assessment if that is violated, so a bug that
inflated a score would be caught before the report is built rather than after it
is presented.

Every capped dimension records `cap_reason`, and the report prints
"claimed X, scored Y, because Z". Never present a capped number without its
reason.

### Why the gate exists

A maturity model describes what an organization *does*, and an organization that
genuinely operates at 300 or above has artifacts, because 300 is where things
become documented and governed. If nobody can name the document, the register,
the dashboard or the person, the practice is aspiration rather than operation.
The gate does not accuse anyone of lying; it distinguishes intent from
installed practice.

### When a customer challenges a cap

Do not re-score in the room from memory. Do this instead:

1. Read back the anchor they chose and confirm it is still the right one.
2. Ask again for the artifact, in the narrowest possible form: not "do you have
   governance" but "what is the file called, and who owns it".
3. If they produce it, add it to `evidence` in the answers file, re-run
   `agent-maturity score` and `agent-maturity validate`, and rebuild the report.
   The score moves because the evidence moved, which is exactly the behavior you
   want them to see.
4. If they cannot, leave the cap and record the disagreement in the debrief. A
   cap you removed under pressure makes every other number in the report
   negotiable.

## 3. Confidence tags

| Tag | Set when | Rendered as |
| --- | --- | --- |
| `evidenced` | `evidence` is a non-empty string | Solid spoke, filled vertex |
| `asserted` | An anchor was chosen but no artifact named | Amber dashed spoke, hollow vertex |
| `inferred` | The answer carries `"inferred": true` | Amber dashed spoke, hollow vertex |

Use `inferred` when the customer did not know rather than guessing on their
behalf, and never round upward when you do. A pillar whose floor is `inferred`
is telling you the organization has no shared view of itself - usually a pillar
E finding in its own right.

`agent-maturity validate` refuses an `evidenced` tag without a matching artifact.

## 4. Conservative diagnostic floor, not an official overall score

**A pillar's level is `min(sub-dimension levels)`.**

Microsoft says **each capability pillar is assessed** across the five levels and
explicitly allows domains or platforms to mature at different speeds. It does
not publish this project's minimum-based algorithm or one organization-wide
score. The official-model result is therefore the five-pillar profile.

The project additionally computes a conservative pillar floor. It is useful for
finding a binding constraint, but must always be labeled **project diagnostic
floor**, never "Microsoft maturity" or "overall maturity".

The mean is computed too, and both are plotted:

- **Solid polygon** - the staged floor. The honest answer to "where are we".
- **Dashed outline** - the mean. Momentum, and where the capability already is.
- **The gap between them is the finding.** A wide gap says the pillar has strong
  areas being held back by one weak sub-dimension, and names it in
  `findings.unevenness[].held_back_by`. That is usually the cheapest improvement
  available, because everything around it is already in place.

The project diagnostic floor is the minimum across all fifteen sub-dimensions, and
`findings.binding_constraint` names every dimension sitting on it.

## 5. Responsible AI is a five-point overlay, not a sixth spoke

Microsoft states that Responsible AI is "embedded across all dimensions", and
writes an RAI clause into each level descriptor of pillars A, C and E with
equivalent trust and oversight content in B and D.

Modelling RAI as a sixth axis would let an organization score well on RAI while
failing it inside every other pillar. Instead each pillar designates exactly one
**RAI-bearing** sub-dimension whose anchors carry that pillar's Responsible AI
characteristic at each level:

| Pillar | RAI-bearing sub-dimension | The RAI content it carries |
| --- | --- | --- |
| A | `A1` Vision and executive sponsorship | Leadership positioning RAI as a strategic pillar |
| B | `B2` Human-agent decision rights and oversight | Humans staying in control; trust and risk indicators |
| C | `C1` Governance framework and agent classification | RAI standards, impact assessments, lifecycle gates |
| D | `D3` Lifecycle, reuse and observability | Continuous posture validation, adversarial testing |
| E | `E3` Community, champions and incentives | RAI habits, ethical reasoning, trust as a value |

The report draws the five selected levels as a blue polygon aligned to pillars
A-E. It must not collapse them into a circle: a circle loses which pillar's
trust posture is 100 and which is 300.

For each pillar, `lags_capability` compares its RAI-bearing dimension with the
mean of that pillar's two non-RAI dimensions. `rai.lagging_pillars` names the
affected axes. This is project-authored diagnostic context, not a Microsoft RAI
score.

## 6. Roadmap generation

The roadmap is generated, not authored, so it can never drift from the scoring
or from the Learn source.

For each selected dimension the roadmap states the current anchor text as
"today looks like" and the **next level's anchor text** as "at the next level".
The anchor is already a description of observable behavior in the customer's own
language, so the target state needs no separate writing.

Priority order:

1. **The binding constraint** - the dimension(s) at the overall floor. The whole
   assessment is floored here, so nothing else moves the headline number.
2. **Capped dimensions** - use `action_type: evidence-closure`. The next action
   is to name and review the missing artifact, pass the disconfirming probe, or
   run Standard/Deep after a Pulse screen. Do not tell the customer to build a
   capability they already claim to have.
3. **Remaining dimensions, lowest first.**

Six items maximum. A roadmap longer than that is a backlog, and a customer
leaves a debrief remembering two things.

## 7. Assessment schema

`agent-maturity-assessment/2`, produced by `agent-maturity score`, checked by
`agent-maturity validate`, and the only thing any renderer reads.

```
schema        "agent-maturity-assessment/2"
generated_at  ISO 8601 local time
model         { name, root, retrieved, levels, level_names }
methodology   { classification, official_model_output, project_authored[] }
engagement    copied verbatim from the answers file
pillars[]     id, name{en,zh}, source, staged, mean, spread, dimensions[]
  dimensions[]  id, name{en,zh}, source_heading, rai_bearing,
                claimed, level, capped, cap_reason{en,zh} or null, cap_codes[],
                confidence, evidence, quote, qc_answer, qc_passed, probe2_answer,
                claimed_anchor{en,zh}, current_anchor{en,zh},
                next_level, next_anchor{en,zh}
overall       { staged, mean, official:false, label{en,zh} }
rai           { staged, mean, dimensions[], profile[],
                lagging_pillars[], lags_capability }
findings      binding_constraint { level, dimensions[] }
              unevenness[] { pillar, staged, mean, spread, held_back_by[] }
              capped[] { id, claimed, level, reason{en,zh} }
              confidence_counts { evidenced, asserted, inferred }
              roadmap[] { priority, dimension, name{en,zh}, action_type, from, to,
                          today_looks_like{en,zh}, next_looks_like{en,zh},
                          next_action{en,zh}, why_here{en,zh} }
```

Every customer-visible string in the assessment is an `{en, zh}` object, so a
renderer picks a language and never falls back to the other one mid-report.

Invariants the validator enforces: exactly five pillars; 15 to 18
sub-dimensions; every pillar `source` on `learn.microsoft.com`; `level` never
above `claimed`; `capped` consistent with `level != claimed`; a `cap_reason`
whenever capped; `evidenced` only with an artifact; every staged floor equal to
the minimum of its sub-dimension levels; every mean recomputed and matching;
exactly five RAI-bearing dimensions matching the axis-aligned `rai.profile`;
RAI means and per-pillar lag flags recomputed; `qc_passed=true` only with a
preserved Q-C answer; the binding
constraint equal to the overall floor; confidence counts accounting for every
sub-dimension; and every roadmap item carrying a valid action type and moving
upward.

Adding a renderer means reading this schema. It does not mean touching the
interview or the scoring.
