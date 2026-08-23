# Choice prompts across hosts

An enumerable decision should arrive as the host's own selection card wherever the host has one, and as plain text wherever it does not. The card earns its place: it removes typing, it puts each option's consequence next to the option instead of three paragraphs above it, and it returns an answer you can act on rather than prose you have to interpret.

The trap is writing the rule against one host. `AskUserQuestion` does not exist in opencode, `question` does not exist in Claude Code, and `request_user_input` exists in neither. A skill body that names one of them is broken everywhere else — and broken quietly, because a missing tool does not raise an error. The question simply never gets asked, and the agent proceeds on a guess.

So the division is: **skill bodies describe the question; this file maps it onto whatever the host actually exposes.**

## The normalised question

Every host with a selection card accepts some spelling of the same five things. Design against these, never against a host's field names.

| Normalised | What it carries |
| --- | --- |
| `question` | The decision, stated in full, in the user's language |
| `header` | A short label for the card, in the user's language. The length limit differs by host |
| `options[].label` | Two to four concrete choices, in the user's language; when structural evidence supports a recommendation, put it first |
| `options[].description` | The reason, consequence, or trade-off, in the user's language. Never a restatement of the label |
| `select-many` | Whether several options may be chosen at once |

Nothing beyond these five is portable. A question designed around a field only one host has stops working on the next machine — and so does one designed around one language: a body that writes an option label as a backticked English literal reads like an identifier to reproduce verbatim, which is how a translated card ends up with an untranslated control word stranded in it.

## Authoring metadata versus the wire

A recommendation, its evidence, and a no-free-text escape hatch all used to be
spelled straight into the wire fields above: the literal English text
`(Recommended)` inside a label, a freeform evidence string, and the literal
English fallback option "None of these — let me explain". All three worked
only in English. A translated label carrying the same meaning had no marker
the guard recognised, so an unevidenced recommendation passed unchecked, and a
translated card with no free-text host got an English fallback stapled onto
it regardless of what language the rest of the card was in.

So authoring keeps a few fields that never reach a host, and rendering
converts them into the five normalised fields above before anything is sent:

| Authoring-only field | Carries |
| --- | --- |
| `options[].recommended` | A structural flag, not text. This is the recommendation — never signal it by writing marker text into the label by hand; a body of text is not a portable signal, and a hand-written marker with no flag is rejected outright. |
| `recommendationLabel` | The marker, written in the user's language (`(Recommended)`, `（推荐）`, ...). Rendering appends it to the flagged option's label; nothing else about the label changes. |
| `recommendationEvidence` | `{ basis, detail }`. `basis` must be `confirmed` or `documented` — the same two strongest values as the Evidence column below, and for the same reason: `assumed` and `unknown` are not strong enough to steer a user's choice, only to describe a host's tooling. `detail` says what was actually confirmed or documented. |
| `escapeOption` | `{ label, description }`, authored in the user's language, used verbatim in place of any built-in fallback when the host has no free-text entry. |
| `grantsAuthority` | True on a card whose approval hands the agent authority it did not already have. Such a card is rejected if any option is flagged `recommended`, regardless of the evidence behind it — see below. |

## Mode selection at brief closure

Mode selection is a constrained workflow decision, not a safety override. The
persisted control value (`full` or `compact`) is not the text the user reads —
the card presents the Agent's evidence-based recommendation first and
describes, in the user's own language, what the user will experience. In
Chinese the two mode choices display as 完整模式 and 尝试精简模式; neither
display string is the persisted value, and no body may write the persisted
value into the card the user sees.

| Choice | Persisted value | Description |
| --- | --- | --- |
| 完整模式 | `full` | Approves the displayed brief now; capability survey follows, then a separate plan review. That review offers the conservative choice first: `批准计划` (`approve-plan-only`), then `批准并自动完成` (`approve-and-auto-execute`), then `修订计划` (`revise`), then `取消` (`cancel`). |
| 尝试精简模式 | `compact` | Starts no-probe bundle assembly; the brief, capability map, and actual plan receive one later atomic review. |
| 修订简报 | n/a | Returns to clarification because the displayed contract is not ready. |
| 取消 | n/a | Stops without approving or executing task work. |

When Compact has a known disqualifier, do not render it as a forceable choice;
state the reason beside the Full recommendation. When a Compact attempt later
proves ineligible, explain the recorded upgrade reason and continue at the next
Full gate without displaying this card again. The selection approves a Full
brief, but no selection authorizes an unseen plan.

This is exactly the non-authorizing case the `grantsAuthority` guard above
exists to tell apart from the authorizing one: mode selection may put its
evidence-backed recommendation first because approving it authorizes nothing
by itself. A card whose approval instead grants execution authority — such as
the plan-review menu above — marks itself `grantsAuthority`, stays
conservative-first, and carries no recommendation, however strong the
evidence.

## Host bindings

The `Evidence` column describes this table, not the host.

| Value | Means |
| --- | --- |
| `confirmed` | Observed directly — the tool registry the host sends, a live call, or the host's own error message |
| `documented` | The vendor says so, but it was not observed here |
| `assumed` | Inferred from a shared protocol or product family, and not observed |
| `unknown` | Nobody has checked from inside that host |

A row may say the host has **no** card only on `confirmed` evidence. Asserting absence is a claim, and it needs the same standard as asserting presence.

**`unknown` is not `none`.** `unknown` says nobody has checked; `none` says somebody checked and there was nothing there. Only the second is a finding. Collapsing them costs the user a card they actually had, and it is the same error this pack forbids everywhere else.

| Host | Tool | Select-many field | Header limit | Free text | Evidence |
| --- | --- | --- | --- | --- | --- |
| Claude Code | `AskUserQuestion` | `multiSelect` | 12 | built in | documented |
| Claude Cowork | `AskUserQuestion` | `multiSelect` | 12 | built in | assumed |
| WorkBuddy | `AskUserQuestion` | `multiSelect` | 12 | built in | documented |
| opencode | `question` | `multiple` | 30 | built in | confirmed |
| Codex CLI | `request_user_input` | from schema | from schema | built in | confirmed |
| ChatGPT / Codex desktop | `request_user_input` | from schema | from schema | built in | assumed |
| GitHub Copilot CLI | none | n/a | n/a | n/a | confirmed |
| Microsoft Scout | unknown | n/a | n/a | n/a | unknown |

`from schema` means the card exists but the exact field name was not verified — read it off the tool's own schema rather than guessing from a neighbouring row.

## How these rows were established

The method matters more than the rows, because the rows go stale and the method does not.

- **opencode** — `question` was in the agent's own tool list during a live session, with `multiple` for select-many and free text on by default.
- **Codex CLI** — `codex exec` was asked to enumerate its tools and returned `request_user_input` among them. See the warning below before trusting that.
- **ChatGPT and the Codex desktop app** — inferred, not observed. The tool's types live in Codex's app-server protocol, which is what `codex app` launches the desktop app to speak, so the same card is very likely there under the same name. Verify before relying on it.
- **GitHub Copilot CLI** — the full tool registry the CLI sends to the model was read out of a debug-level session log (`--log-level debug --log-dir`), twice, once with `-p` and once without. Twenty-six tools, none of them a selection card. The model's own enumeration agreed. This is why the row says `none` rather than `unknown`.
- **Claude Code, Claude Cowork, WorkBuddy** — from documentation and from this pack's own first implementation, not observed on the machine these notes were written on.
- **Microsoft Scout** — not installed there, so not checked.

One method that looks reasonable and is not: grepping the host's binary for tool names. It worked on Codex, whose binary carries them as plain strings, and it produced a confident false negative on Copilot CLI, whose binary contains none of the twenty-six names it demonstrably sends. A search that cannot find what is there proves nothing when it finds nothing.

## Being in the tool list is not permission to call it

**Codex CLI advertises `request_user_input` and then refuses it:**

```
ERROR codex_core::tools::router: error=request_user_input is unavailable in Default mode
```

The tool is in the list. The call fails. This is the pack's "presence is not readiness" rule landing on the one capability every other phase depends on, and it defeats a resolution rule that stops at reading the tool list.

So the refusal is a **fallback trigger, not an error to diagnose**. Say the question in plain text in the same turn, end the turn, and do not retry the card. Retrying is how the two-failure limit gets burned on something that was never going to succeed.

## Resolving at runtime

1. **Read your own tool list first.** It is the authority on what exists. This table only supplies field names and limits.
2. **Match by shape, not by name.** A tool that takes a question plus enumerated options is the one, whatever it is called. Names go stale faster than schemas.
3. **Be ready for it to refuse.** A card can be listed and still be unavailable in the mode you are running in. On refusal, fall straight through to plain text — same question, same options, same turn.
4. **If nothing matches, use plain text.** Never call a tool you cannot see. A card that never renders is a question the user never answered, and everything after it is a guess.
5. **If your harness exposes no tool list at all,** use plain text and say once that you could not check. Unexposed is unknown, not empty.


## Plain-text fallback

One question. The options as a short numbered list, each carrying its consequence. Name a recommendation and reason only when evidence supports one. Then **end the turn and wait** — the answer cannot arrive mid-turn, so anything you do after asking is built on a guess.

The fallback loses the card, not the discipline. Keep the same options, consequences, and any evidence-based recommendation.

## When the card cannot carry the question

| Situation | Do this |
| --- | --- |
| The host has no select-many field, but the choices genuinely combine | Ask in plain text, or split it into separate single-select decisions. Never quietly downgrade to single-select: you would be discarding choices the user wanted, and they would never see it happen. |
| More than four options | The question is under-analysed. Group them, or ask a narrowing question first. |
| The header exceeds the host's limit | Shorten the header. Never shorten the question to fit a label. |
| The host's card has no free-text entry | Add the authored `escapeOption`, in the user's language, meaning "none of these — let me explain". Every host in the table above provides free text already, so do **not** add one there; it wastes one of your four slots duplicating something the card does. |
| The answer is open-ended | Plain text. Ask one focused question, why it matters, and one or two non-prescriptive examples. Do not invent options or a recommendation. |
| The input would be sensitive | Do not solicit credentials or secrets in either cards or prose. Ask for a category, a redacted summary/export, or for the user to authenticate themselves. |

## The rule that outranks all of this

A card is a way of presenting a question, not permission to ask one. The budget in the skill body still applies, and so does the stop rule: **if the answer would not change the plan, do not ask it** — in a card or otherwise. Rendering a low-value question beautifully still wastes the user's turn.
