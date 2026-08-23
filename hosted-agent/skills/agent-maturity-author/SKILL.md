---
name: agent-maturity-author
description: Edit, translate, extend or validate the agent maturity question bank. Use when asked to add an industry or sector variant of the maturity assessment, translate the questions into another language, sharpen or reword an anchor after a real engagement, adjust a disconfirming probe or its pass test, add or change a sub-dimension, or check that the question bank still satisfies the invariants the scorer and validator depend on.
license: MIT
---

# Author the question bank

The question bank is data. An industry variant, a new language, or a sharpened
anchor is an edit to `question-bank.json` and no code change. That is the point,
and it is worth protecting.

Bank: `skills/agent-maturity-assess/references/question-bank.json`, also served
as `maturity://references/question-bank.json`.

## Always, after any edit

```bash
agent-maturity check-bank
```

or the `maturity_validate_bank` tool. Then re-score a fixture end to end, which
is the only way to catch a change that parses but scores wrong:

```bash
agent-maturity score --answers fixtures/fabrikam-mid-stage.json --out out/x.json
agent-maturity validate out/x.json
python -m unittest discover -s tests -v
```

## The invariants

These are load-bearing. The bank loader or validator checks them; break one
and scoring, rendering or the radar geometry breaks with it.

- Bank schema `agent-maturity-bank/2`.
- **Exactly five pillars**, each with **exactly three sub-dimensions**. The
  radar has five axes and the pillar aggregation assumes three.
- **Exactly five anchors per anchored question**, mapping one-to-one onto
  100, 200, 300, 400, 500, **in that order**. The customer never sees the
  numbers, but the position is the score.
- A `qa` (anchored choice), `qb` (evidence probe) and `qc` (disconfirming probe)
  on every sub-dimension, and a `qb_batched` prompt on every pillar.
- `qc.fires_at` is `[400, 500]`, and every `qc` carries a `pass_test`.
- **Exactly one `rai_bearing` sub-dimension per pillar.** Responsible AI is not
  a sixth axis - Microsoft states it is embedded across all dimensions - so it
  is carried by one designated sub-dimension per pillar and drawn as a
  five-point overlay.
- Dimension names, Q-A/Q-B/Q-C/probe2 prompts, Q-A anchors and Q-C pass tests
  exist in **both `en` and `zh`**. A missing checked translation is a validation
  failure, not a silent English fallback in front of a customer.
- `source_heading` is a plain string, not a localized node: it is a citation
  back to Microsoft Learn, not UI text.

Four more that the selection card depends on:

- Every sub-dimension carries a **`header`** in both languages, **12 characters
  or fewer**. It is the card's label, and the tightest host silently truncates
  anything longer in front of a customer.
- Every anchor's **card label is derived**, not authored: the first sentence of
  `text` becomes the label and the rest becomes the description. Add
  `qa.anchors[].short.<lang>` **only** for anchors whose first sentence runs
  past 80 characters or does not stand alone. Author it per language and only
  where needed - a Chinese anchor that splits cleanly must be left to derive,
  and `short` deliberately has no both-languages requirement for that reason.
- Every `qc` must yield a **`fail_exemplar`**: either the failing answer quoted
  inside its own `pass_test` (`'We review it regularly' is a fail` /
  `「我们定期 review」算不通过`), or an authored `qc.fail_exemplar` in both
  languages. This seeds the options the agent generates for that probe. Dropping
  the quote without adding an override is a validation failure, not a silent
  fallback.
- **Never widen the anchored question with a free-text option.** Its five
  options are exhaustive and position is the score; an answer outside them has
  no level.

## Writing a good anchor

The anchors are the entire input to the score, so this is where the quality of
the assessment actually lives.

**Write observable behavior, not self-assessment.** "We have a defined
governance process" invites a yes. "A new agent reaches production after a
review that someone can name, and it has blocked at least one thing" describes a
Tuesday the customer either recognizes or does not.

**Make the levels distinguishable without the numbers.** If a customer at 200
and a customer at 300 would both plausibly pick the same option, the anchors are
not doing their job. The distinguishing feature is usually: is it written down,
is it enforced, is it measured, does it improve itself.

**Do not let the top two anchors flatter.** 400 and 500 fire the disconfirming
probe precisely because they are the ones people over-claim. If an anchor at 400
is comfortable to pick, it is written too generously.

**Keep the descriptors traceable.** Each sub-dimension names the Microsoft Learn
heading it derives from in `source_heading`. If you add or reword one, update
`references/pillars.md` too - the report footer prints the source URLs and the
retrieval date, and that traceability is why the result is defensible.

## Writing a good disconfirming probe

A question a genuinely capable organization answers in one sentence, and one
that cannot be answered from a slide. For example: "Without looking it up: when
did leadership last change a priority because of what agent usage data showed,
and what changed?"

The `pass_test` must state what counts as passing in a way another person would
apply the same way. A model judges against it, so write it as a rule, not a
vibe. Bad: "they sound like they know". Good: "names a specific decision and
roughly when it happened".

**Quote the failing answer inside the `pass_test`.** That quoted span is lifted
out as the probe's `fail_exemplar` and seeds the non-answer options the agent
offers on the card, so writing one is not decoration - it is what stops those
options being invented from nothing. A `pass_test` that describes a partial pass
instead, as `D2` does, needs an explicit `qc.fail_exemplar` in both languages.

## Adding a language

Add the language key to every localized node. `agent-maturity check-bank` lists
every missing string by path, so run it, fix what it names, and repeat until it
is clean. Then check the renderers with `--lang <code>` and confirm the radar
labels still fit - `short_name` truncates long axis labels, and a language with
longer words may need that limit adjusted.

Add the language code to `LANGUAGES` in `src/agent_maturity/bank.py`. The
framing questions (language, organization, sector, roles, focus, tier) are
localized in `src/agent_maturity/interview.py` rather than in the bank, because
they are about the engagement rather than the model - translate them there, and
translate `_CARD` beside them: it holds every word a selection card puts in
front of the customer that is not a question from the bank.

Then check the new language's anchors split into readable card labels.
`agent-maturity check-bank` reports every anchor whose derived label runs past
80 characters; those are the ones that need a `short.<code>` override, and only
those.

## Adding an industry variant

Copy the bank, edit the anchors into that industry's vocabulary, and keep every
invariant. Point at it with the `AGENT_MATURITY_BANK` environment variable, with
`bank_path` on `maturity_validate_bank`, or with `--bank` on
`agent-maturity score`.

Resist adding a sixth pillar or a sixteenth sub-dimension. The five pillars are
Microsoft's, and changing them means the result stops being legible to anyone
who has read the model; three-per-pillar is what keeps each pillar equally
weighted.

## What not to change without reading the rubric first

`references/scoring-rubric.md` holds the evidence gate, the staged-floor rule
and the confidence tags. The gate only ever lowers a score, and the validator
enforces that. If you find yourself wanting a rule that raises one, the
assessment has stopped being an assessment.
