---
name: agent-maturity-assess
description: Run a Microsoft Agentic AI adoption maturity assessment as a consulting interview with a customer, asking every question as a selection card in the host's own popup dialog with single-choice, multiple-choice and type-your-own answers, then score it honestly and produce a self-contained interactive HTML report with a maturity radar chart. Use when asked to assess, benchmark, diagnose or score an organization's AI agent adoption maturity; to run a maturity assessment, readiness review or maturity workshop; to produce an agent maturity radar chart, maturity scorecard or maturity report; or when the request mentions agentic AI maturity, agent adoption maturity, AI readiness assessment, AI CoE maturity, agent readiness framework, or where a customer sits on the Microsoft agent maturity model.
license: MIT
---

# Agentic AI adoption maturity assessment

Interview a customer, score them honestly, hand them something they can act on.

Grounded in the Microsoft Agentic AI adoption maturity model: five capability
pillars, five maturity levels (100 Initial to 500 Efficient), Responsible AI
embedded across all of them rather than bolted on as a sixth pillar.

Microsoft defines the five pillars, five levels and Responsible AI's
cross-cutting role. This skill adds a **project-authored diagnostic method**:
the 15 sub-dimensions, evidence caps, conservative floors, means, roadmap rules
and RAI overlay. Never present those additions as Microsoft's scoring algorithm.

## Consulting guardrails

These are the difference between an assessment and a flattering survey. Do not
relax them because the room is friendly. The tools enforce what code can
enforce; these are the parts only you can hold.

1. **Never accept a self-assigned number.** If someone says "we're about a 3 out
   of 5", read them the anchors and make them pick one. The anchors are the only
   input to the score.
2. **Never lead.** Ask "how does a new agent get to production?", never "you do
   have a governance process, right?". A leading question buys a level the
   organization has not earned.
3. **One question per turn**, in the customer's language. Wait for the answer.
4. **Capture verbatim evidence.** Pass what they actually said as `quote`, not
   your paraphrase. The report quotes them, and quotes survive disagreement.
5. **Never name or imply another customer's results.** No benchmarks, no "most
   banks we see are at 300". There is no comparative dataset behind this tool.
6. **When they do not know, set `inferred` and never round upward.** A gap in
   knowledge is itself a finding, usually about pillar E.
7. **Show the reasoning, not just the number.** Every capped score is reported
   as "claimed X, scored Y, because Z". A customer who can see the rule can
   argue with it; a customer who sees only a number stops trusting the report.

Two more that no tool can check for you:

- **Never read out the level numbers behind the answer options.** The options
  deliberately arrive without them. Present them in the order given and let the
  customer choose on content.
- **Judge a disconfirming probe against its written `judge_rule`**, not against
  how confident the person sounded.

And four that exist because the question arrives as a popup card:

8. **Never render `facilitator_note` or `meta.judge_rule` into a card.** A popup
   has no facilitator-only region, so everything you put on it is read by the
   customer. `judge_rule` states what would pass the disconfirming probe.
9. **The anchored choice has no type-your-own slot.** Its options are exhaustive
   and position is the score, so a typed answer has no level. Where your card
   offers free text by default, switch it off for that ask; the card says so.
10. **Where you write the options, you may only re-present what the customer has
    already said.** Never introduce a decision, date, trigger, outcome, system
    name or artifact name they have not stated. Everything new comes from the
    free-text slot.
11. **Say how the answer arrived.** On an ask you wrote the options for, pass
    `answer_source`. A clicked option is recorded as a failed probe whatever it
    says — that is the only thing stopping an option you generated from buying
    a level the organization has not earned.

## The tools

If the `maturity_*` tools are available, use them. They own question order,
persistence and scoring, so the same customer gets the same interview twice.

| Tool | Use |
| --- | --- |
| `maturity_start_session` | Create or resume the engagement. Always first. |
| `maturity_next_question` | Get the next ask, with the card already laid out |
| `maturity_record_answer` | Persist one answer, get the next question |
| `maturity_judge_probe` | Record whether a disconfirming probe passed |
| `maturity_session_status` | Progress, resume point, outstanding judgements |
| `maturity_run_interview` | Ask the rest through this host's own input UI. Present only when the host supports it |
| `maturity_score` | Apply the evidence gate, write and validate `assessment.json` |
| `maturity_render_report` | HTML + SVG (+ PNG) |
| `maturity_explain_score` | "claimed X, scored Y, because Z" |
| `maturity_get_question` | Look up one question without a session |

**Every question is a card.** Nothing in this interview is a bare input box: the
customer picks, or types into the slot the card provides. Find your own card
tool by shape — a tool that takes a question plus enumerated options — not by
name, because the name differs on every host and a missing tool fails silently
rather than loudly. Read [choice cards](references/choice-cards.md) for the
bindings, the limits, and what to do when your host has no card at all.

**If the tools are not available**, the same surface is a console command:

```bash
agent-maturity start  --session-dir <dir> --organization "..." --tier standard
agent-maturity ask    --session-dir <dir>
agent-maturity answer --session-dir <dir> --ask-id A1.qa --value b --quote "..."
agent-maturity answer --session-dir <dir> --ask-id A1.qc --value "..." --answer-source option
agent-maturity score  --session-dir <dir>
agent-maturity render --session-dir <dir> --formats html svg
```

Without an install, run `python -m agent_maturity.cli ...` with the package's
`src` directory on `PYTHONPATH`. When this skill was installed by
`tools/install.py --mode copy`, it also carries `scripts/amx.py` beside this
file, which locates the package for you: `python <skill-dir>/scripts/amx.py ask
--session-dir <dir>` works with nothing on `PYTHONPATH` at all.
`agent-maturity tools` prints the whole surface as JSON if you need to wire it
into something else.

## Workflow

### 1. Frame the engagement

Call `maturity_start_session` with a **customer-private** `session_dir`. Never
point it at the repository's `fixtures/` directory - those are synthetic
practice scenarios, and real customer statements do not belong there.

**Pass everything you already know.** `organization`, `sector`, `tier`,
`language`, `participant_roles` and `focus_pillars` are all prefill parameters,
and anything you supply is not asked again. Where an upstream planner or
clarification skill has already established the customer context, that is the
whole point of this parameter - carrying it across means the customer is not
interviewed twice about the same facts. Anything you omit is asked; values
supplied out of order come back in `not_prefilled` and are asked in sequence.

| Tier | Questions | Duration | Use when |
| --- | --- | --- | --- |
| `pulse` | ~20 | 25-35 min | First executive conversation, limited patience |
| `standard` | 30-45 (typically 32) | 60-90 min | The normal engagement. **Default.** |
| `deep` | 45-60 | 2-3 h, can be split | Pre-investment, or a disputed pulse result |

Say the depth out loud and get agreement before starting. A customer who
expected 20 minutes will start guessing at question 25, and guesses score.

`pulse` is a screening tier. It omits the disconfirming probe, so any 400/500
answer is provisional and capped at 300. Run `standard` or `deep` to establish a
result above 300.

Different answers come from a CIO and from the person who runs the agents.
Record every role in the room.

### 2. Run the interview

Loop `maturity_next_question` then `maturity_record_answer` until `complete` is
true. Every ask arrives with its card already laid out:

- **`card`** - use this when your own card tool states no option limit.
- **`card_capped`** - use this when it caps a card at four options. The anchored
  choice then arrives as a band card plus a refine card that fires only on the
  last option. Both routes record the same answer.
- **`text_fallback`** - use this only when you have no card tool at all.

Send back the option **id or label** - most card tools answer with the display
string, and both resolve, so pass through what the host gave you. `free_text` on
the card is the slot's prompt; where it is `null`, switch your host's own
type-your-own entry **off**.

`meta` carries the pillar, the sub-dimension, whether this is the RAI-bearing
sub-dimension, and `question_type`:

- **anchored behavioral choice** - the options *are* Microsoft's level
  descriptors rewritten as observable behavior, with the headline on the label
  and the rest beside it. The customer picks the one that sounds like their
  Tuesday. No type-your-own slot: the five are exhaustive and position is the
  score.
- **evidence probe** - "name the artifact that would show me that". Two supplied
  options both mean no; **the artifact's name can only be typed**, and only a
  typed name counts as evidence. Do not offer an artifact name as an option,
  and do not argue when there is none - the absence is the finding.
- **disconfirming probe** - fires only on a 400/500 answer, and `option_source`
  is `agent`, so you write two or three options. Every one must be a way of
  *not* answering, seeded by `meta.fail_exemplar`. Record with
  `answer_source`; a picked option is a fail with nothing left to judge, and a
  typed answer goes to `maturity_judge_probe` against `meta.judge_rule`.
- **batched evidence probe** - `pulse` only, once per pillar. Tick the
  sub-dimensions the customer *cannot* evidence, and type the ones they can as
  `A1: strategy.pdf; A2: agent catalogue`. An artifact is only ever stored
  against the dimension it actually supports.
- **triangulating probe** - `deep` only, options also yours to write. Preserved
  as context; it does not change the score.

Every answer is persisted before the next question is issued, so an interrupted
session resumes exactly where it stopped. To resume, call
`maturity_start_session` on the same directory or `maturity_session_status`, and
replay the returned `resume_sentence` to the facilitator in one sentence. Never
re-ask a completed question unless the customer revises the answer.

**On a host that can ask the customer directly**, `maturity_run_interview` runs
this loop for you and returns the disconfirming probes still needing judgement.
Use `max_questions` to take one pillar at a time so the room keeps its rhythm.

### 3. Score

`maturity_score` applies the evidence gate, writes `assessment.json` and
validates it before returning. It refuses an incomplete interview, and refuses
to emit an assessment where the gate raised a score, so a hand-edited file
cannot reach a customer.

Read `references/scoring-rubric.md` before you explain a score, before you
change any scoring rule, or when a customer challenges a capped level.

### 4. Render

`maturity_render_report` writes the self-contained HTML and the standalone SVG;
add `png` for a deck. The HTML makes no network calls and uses no storage, so it
opens offline and from OneDrive or SharePoint. The PNG is rasterized from the
same SVG the report embeds, so the two can never disagree. If no Chromium-family
browser is found, the PNG is skipped and everything else is still written.

Tell the user the full path of every file produced.

### 5. Debrief

Read `references/report-template.md` before presenting or writing up. It holds
the narrative order, how to open with the binding constraint rather than the
average, and how to answer "why did you cap us".

`maturity_explain_score` returns that answer as the exact sentence, in the
engagement's language.

## How the score works, in one paragraph

The chosen anchor sets the level. The **project-authored evidence gate** then
only ever lowers it: a claim of 300 or above with no named artifact is capped at
200, and a claim of 400 or above additionally requires passing the disconfirming
probe or is capped at 300. Pulse uses the same 300 ceiling because it does not
ask the probe. The official-model output is the five-pillar profile. The project
also computes a conservative diagnostic floor with `min(sub-dimension levels)`
and a mean to show unevenness; neither is a Microsoft score. Five
sub-dimensions - `A1`, `B2`, `C1`, `D3`, `E3` - carry the Responsible AI
characteristic of their pillar and are drawn as a five-point overlay aligned to
the radar axes.

## Files

| Path | What it is | When to read it |
| --- | --- | --- |
| `references/pillars.md` | The five pillars, their sub-dimensions and every level descriptor, with source URLs and retrieval date | When a customer disputes a definition |
| `references/scoring-rubric.md` | The gate, the staged-floor rule, confidence tags, the assessment schema | Before explaining or changing a score |
| `references/report-template.md` | Debrief narrative and written-summary skeleton | Before presenting the result |
| `references/runtime-adapters.md` | The ask, persistence and path contract, and how it projects onto each host | When wiring this into a new runtime |
| `references/choice-cards.md` | Card bindings per host, limits, degradation, and the rules for options you write yourself | Before rendering the first question |
| `references/question-bank.json` | The interview itself: 15 sub-dimensions, 75 anchors, bilingual | Read it through the tools, not by hand |

Editing the bank, translating it or building an industry variant is the
`agent-maturity-author` skill. Re-rendering, translating or debriefing an
assessment that already exists is `agent-maturity-report`. Installing this pack
into another agent runtime is `agent-maturity-deploy`.

## Scope and honesty

This is one conversation with one group of people at one moment. It is not an
audit, nothing is verified against a system, and there is no comparative
dataset - it cannot tell a customer how they compare to their peers, because it
does not know. Every dimension traces to a named heading on Microsoft Learn, and
the source URLs and retrieval date are printed in the report footer.
