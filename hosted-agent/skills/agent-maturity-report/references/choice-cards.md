# Selection cards across hosts

Every question in this assessment is a card. The customer picks, or types into
the slot the card provides; nothing is a bare input box waiting for prose.

The trap is writing the rule against one host. `AskUserQuestion` does not exist
in opencode, `question` does not exist in Claude Code, and `request_user_input`
exists in neither. A skill body that names one of them is broken everywhere
else — and broken quietly, because a missing tool does not raise an error. The
question simply never gets asked, and the assessment scores a guess.

So the division is: **`SKILL.md` describes the question; this file maps it onto
whatever the host actually exposes.** A test enforces that `SKILL.md` names no
host tool.

## The two invariants

Everything below is arrangement. These two are not.

1. **Rendering never changes what gets recorded.** A five-option anchored
   question asked as one card, and the same question asked as a band card plus
   a refine card, resolve to the same option id and therefore to the same level.
   `answers.json` never learns which route the customer took. Reshape the cards
   freely; you may not reshape the answer.
2. **A picked option can never pass a disconfirming probe.** On a `qc` ask you
   write the options yourself, so the only thing standing between a generated
   option and a manufactured pass is the channel: anything clicked is recorded
   as a fail whatever it says, and only text the customer typed reaches a
   judgement. This is enforced by `maturity_record_answer`, not by your restraint.

## What the tools hand you

`maturity_next_question` returns one runtime-neutral ask with three projections
already built:

| Field | Use |
| --- | --- |
| `card` | the card laid out for a host with no option limit |
| `card_capped` | the same ask laid out for a host that caps a card at four options and a twelve-character header |
| `text_fallback` | the whole question as a lettered list, for a host with no card at all |

Each card carries the five portable fields and nothing host-specific:

| Normalised | What it carries |
| --- | --- |
| `header` | A short label for the card, in the customer's language |
| `question` | The question in full, in the customer's language |
| `options[].label` | The choice, short enough to read at a glance |
| `options[].description` | The rest of it — never a restatement of the label |
| `select_many` | Whether several options may be chosen at once |

Plus two this assessment needs:

| Field | What it carries |
| --- | --- |
| `free_text` | The slot's prompt, or `null`. **`null` means switch the host's own free-text entry off**, not "unspecified" |
| `option_source` | `fixed` when the options are supplied, `agent` when you write them |

## Ask kinds

| Kind | Card | Answer | Text-only fallback |
| --- | --- | --- | --- |
| `single` | one selection card | one option id | lettered list; ask for one letter |
| `multi` | multi-select | zero or more option ids | lettered list; comma-separated letters |
| `text` | a card whose options you generate, plus the free-text slot | the customer's words | the question, then wait |

## Host bindings

The `Evidence` column describes this table, not the host.

| Value | Means |
| --- | --- |
| `confirmed` | Observed directly — the tool registry the host sent, a live call, or the host's own error message |
| `documented` | The vendor says so, but it was not observed here |
| `assumed` | Inferred from a shared protocol or product family, and not observed |
| `unknown` | Nobody has checked from inside that host |

A row may say a host has **no** card only on `confirmed` evidence. Asserting
absence is a claim and needs the same standard as asserting presence.
**`unknown` is not `none`**: `unknown` says nobody checked, `none` says somebody
checked and there was nothing there. Only the second is a finding.

| Host | Tool | Select-many | Header limit | Max options | Free text | Answers with | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| opencode | `question` | `multiple` | 30 | not stated | `custom`, on by default | labels | confirmed |
| Claude Code | `AskUserQuestion` | `multiSelect` | 12 | 4 | built in | labels | documented |
| Claude Cowork | `AskUserQuestion` | `multiSelect` | 12 | 4 | built in | labels | assumed |
| Codex CLI | `request_user_input` | from schema | from schema | from schema | built in | from schema | assumed |
| GitHub Copilot CLI | none | n/a | n/a | n/a | n/a | n/a | unknown |
| Microsoft Scout | unknown | n/a | n/a | n/a | n/a | n/a | unknown |
| MCP client | `elicitation/create` | array `items.anyOf` | n/a | not stated | string field | ids | confirmed |

`from schema` means the card exists but the exact field was not verified here —
read it off the tool's own schema rather than guessing from a neighbouring row.

### How these rows were established

The method matters more than the rows, because the rows go stale and the method
does not.

- **opencode** — `question` was in the agent's own tool list during a live
  session while this pack was being written. Its schema states `header` is
  "max 30 chars", `multiple` enables multi-select, `custom` defaults to on and
  appends a "Type your own answer" option, and answers "are returned as arrays
  of labels". No maximum option count is stated, which is why the row says
  "not stated" rather than a number.
- **MCP client** — `mcp/elicit.py` in this package is the implementation, and
  `tests/test_docs.py` asserts the schema it emits against the table in
  `runtime-adapters.md`.
- **Claude Code, Claude Cowork** — from vendor documentation and from prior
  implementations, not observed on the machine these notes were written on.
- **Codex CLI, Copilot CLI, Microsoft Scout** — not checked from inside those
  hosts for this pack. `unknown`, deliberately, rather than `none`.

One method that looks reasonable and is not: grepping the host's binary for
tool names. A search that cannot find what is there proves nothing when it
finds nothing.

## Resolving at runtime

1. **Read your own tool list first.** It is the authority on what exists. This
   table only supplies field names and limits.
2. **Match by shape, not by name.** A tool that takes a question plus enumerated
   options is the one, whatever it is called. Names go stale faster than schemas.
3. **Read the limits off that schema**, then use `card` or `card_capped`
   accordingly. If your schema states no option limit, use `card`.
4. **Be ready for it to refuse.** A card can be listed and still be unavailable
   in the mode you are running in. On refusal, fall straight through to
   `text_fallback` — same question, same options, same turn. Do not retry the
   card; the mode will not change because you asked twice.
5. **If nothing matches, use `text_fallback`.** Never call a tool you cannot see.
6. **If your harness exposes no tool list at all,** use `text_fallback` and say
   once that you could not check. Unexposed is unknown, not empty.

## Sending the answer back

`maturity_record_answer` takes the option **id** or the option **label** — most
card tools answer with the display string, and both resolve to the same id, so
pass through whatever the host gave you rather than mapping it yourself.

On an ask whose `option_source` is `agent`, also pass `answer_source`:

| The customer | `answer_source` | Effect |
| --- | --- | --- |
| clicked an option you wrote | `option` | on a `qc`, recorded as a failed probe immediately; no judgement is outstanding |
| typed into the free-text slot | `free_text` | on a `qc`, left for `maturity_judge_probe` |

Where `option_source` is `fixed` this is derived and you may omit it.

## Writing the options you are asked to write

Two asks hand you the pen. `meta.option_rule` states the rule on each; this is
why it says what it says.

**The disconfirming probe (`qc`).** Generate two or three options. Every one
must be a way of *not* answering — vague, generic, or "I would have to check" —
worded in this customer's own vocabulary and seeded by `meta.fail_exemplar`,
which is the failing answer this sub-dimension's `pass_test` names. None may
contain the specificity `meta.judge_rule` tests for, and you may only
re-present something the customer has already said in this session.

The card must say, in the question, that saying the actual thing is the answer
that counts and that the options are the usual ways of not being able to. The
tools put that sentence in `prompt` for you; do not remove it. Without it a
customer reads a generated option as a menu of good answers, clicks one that
sounds right, and is capped for an answer they actually had.

**The triangulating probe (`probe2`).** The same, minus the stakes: it is never
scored, so an option here changes nothing but the conversation.

**The evidence probe (`qb`) does not hand you the pen, and this is deliberate.**
`qc` has a judge behind it; `qb` has a purely mechanical non-empty test. An
artifact name you generated, clicked by a customer, would open the evidence
gate on nothing at all, with no second line of defence. Its two options are
supplied and both mean "no". The artifact's name can only be typed.

## What must never reach a card

A popup has no facilitator-only region. Everything you render is read by whoever
is at the keyboard, who is usually the customer.

| Field | Why not |
| --- | --- |
| `facilitator_note` | Discusses scoring; one names the levels that fire the probe |
| `meta.judge_rule` | States what would pass the disconfirming probe |
| `meta.fail_exemplar` | Seed it, do not paste it — a verbatim exemplar reads as a suggested answer |
| The level numbers | They are deliberately absent from the ask. Do not look them up and volunteer them |

## When the card cannot carry the question

`render_plan` applies these; the table is here so its output is readable.

| Situation | What happens |
| --- | --- |
| More options than the host allows, and a band is collapsible | The band folds behind one option and a refine card follows. Both routes record the same id |
| More options than the host allows, and nothing is collapsible | `plain-text`. The question is under-analysed, not badly rendered |
| The host has no multi-select | `plain-text`. Quietly dropping to single-select discards choices the customer made, and they never see it happen |
| The header is over the host's limit | The header is shortened and a `header-shortened` warning is raised. **Never shorten the question to fit a label** |
| The host has no free-text entry and the ask needs one | `plain-text`. A synthetic "type here" option cannot collect the text it promises and must never be stored as the answer |
| The anchored choice on a host with free text on by default | `free_text` is `null`: switch it off. Five anchors are exhaustive, and a typed answer has no level |

## The rule that outranks all of this

A card is a way of presenting a question, not permission to ask one. The tier
still governs how many questions there are, the sequence still governs their
order, and a question the sequence did not issue is not asked because it would
render nicely.
