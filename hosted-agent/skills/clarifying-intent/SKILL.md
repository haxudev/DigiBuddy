---
name: clarifying-intent
description: Turns an unclear or high-impact request into a written, approved brief before planning or execution. Use for ambiguous or broad asks (帮我看看 / 调研一下 / 做个方案 / 搞一下 / 优化下 / 分析一下), and when the router needs an approval artifact even if the request is already complete. Asks one plan-changing decision per turn, only while an unresolved item would still change the plan, with concrete trade-offs where choices are real. Produces .superclarity/<task>/brief.md. Do NOT use independently of the router, for plain factual questions, or to reopen execution details that do not affect the plan.
license: MIT
metadata:
  pack: superclarity
  phase: clarify
---

# Ask only what changes the plan

Unspoken defaults create polished work aimed at the wrong problem. Too many
questions make users abandon clarification entirely. The target is not maximum
information; it is enough shared definition to plan safely. Answer in the
user's language.

## Start from evidence

Read the request, the tools and skills preflight saw this session, and only the
narrow project context needed to make choices concrete. Do not perform research,
analysis, or drafting that advances the task itself before approval.

Create [`brief.md`](templates/brief.md) as `draft` before the first question and
update it after every answer, so progress survives compaction. Open
`ledger.jsonl` with its task header, then record when the brief appeared:

```json
{"seq":1,"at":"<ISO>","kind":"task","task":"<slug>","schema":"task-ledger/2"}
{"seq":2,"at":"<ISO>","kind":"artifact","artifact":"brief","revision":1,"digest":"sha256:<of brief.md>"}
```

One JSON object per line, `seq` counting up from 1, `at` never going backwards,
and `at` at or after the file it records. Later phases order themselves against
these events, so a malformed first line puts the task into recovery. Append it
again whenever the bytes change — approval is one, dated `approved_at` — and with
the next revision when the brief is revised; the latest digest must match it.

## When to ask

- Ask one decision per turn, and ask nothing the request already settles.
- Keep asking only while an unresolved item would change scope, providers,
  dependencies, risk, success criteria, or the shape of the deliverable. Stop
  when none remains. There is no number to reach and no quota to spend.
- Record every prompt in the brief's `Discovery log` before putting it, naming
  the decisions it affects and what stays blocked without it. The count is that
  table's length; it is never asserted separately.
- `Brief approval`, information the user volunteered, and user-initiated
  revision are user turns, not prompts you chose. They never appear in the log.
- Re-ask a decision only after a partial, contradicted, or withdrawn outcome.
  A settled decision is not reopened by asking again.
- Show which decisions are still unresolved and which one this prompt settles.
  Never show a remaining quota: a counter that looks like an allowance gets
  spent, and a user reading one treats the next question as owed.

The stop rule is the whole budget: **if an answer would not change the plan, do
not ask.** Assume and flag only low-impact profile details; never use an
assumption to close a universal dimension. Never guess a high-impact fact
because asking feels expensive — pause with the item and its consequence.
Ending the interview does not authorize an incomplete brief.

Read [the discovery log](references/discovery-log.md) for the event grammar,
the basis prefixes, and what to do when a decision stops converging.

## Design each prompt

For a real closed choice, use two to four mutually intelligible options. Put the
recommended option first only when evidence supports a recommendation, and
attach the reason or consequence to each option. A bare menu transfers work
without helping the user decide.

For an open question, ask one focused thing, explain why it changes the plan,
and give one or two non-prescriptive examples. Do not invent choices or
recommend an answer. Never solicit credentials or secrets; ask the user to
authenticate themselves, name a category, or provide a redacted export.

Every option must be feasible. An option with no visible provider costs a full
approval round, because survey will reject it after the brief is already
approved. When the approach the user implies has no visible provider, that
absence is the question — install it, substitute something weaker, or drop the
scope — never a silent option in a menu. Visibility is not readiness: a visible
provider may still be logged out, so never record one as `confirmed` here.

Use the host's native selection card when its visible schema supports the
question; otherwise render the same choice in plain text and end the turn. Read
[choice prompts](references/choice-prompts.md) for portable bindings and
fallbacks; never hardcode a host tool name.

## Handle imperfect answers

- Accept volunteered answers to later dimensions and do not ask them again.
- "I don't know" or "use your judgment": for a low-impact profile detail,
  record a disclosed safe assumption. For a universal dimension, vague
  delegation is not confirmation: present one concrete default and its
  consequence, then obtain explicit acceptance. When high impact, pause.
- Partial or ambiguous replies are not approval.
- If an answer contradicts an earlier one, show the conflict and ask which
  governs; record it under `Pending precedence` before ending the turn so it
  survives compaction. Do not silently choose or restart the interview. Clear
  it only after the user selects which answer governs.
- If the user changes the task, revise the brief and invalidate downstream
  artifacts rather than stretching the old scope. Never edit an approved brief
  in place; that is recovery, not a revision.

## Closure invariant

Before approval, the five universal dimensions below are confirmed. A basis is
`request:`, `discovery:<ID>:<ISO>:`, `volunteered:<ISO>:`, or `revision:<ISO>:`,
each followed by its evidence. Profile-required dimensions may instead be
explicitly assumed when low impact, or deferred to a named gate that the profile
marks deferrable and that cannot invalidate planning:

| Dimension | What must be clear |
| --- | --- |
| Problem/current state | what is happening now and why change is needed, when applicable |
| Outcome and audience | what is produced, who uses it, and which decision it supports |
| Scope boundary | specific inclusions and explicit exclusions |
| Constraints | time, effort, format, sources, access and exposure |
| Success criteria | checks an uninvolved person can apply |

A domain profile can add dimensions. Select it from the names preflight
recorded, validate the one that matches, and copy its exact bytes to task-local
`profile.md`, appending `{"kind":"artifact","artifact":"profile"}` with the next
`seq`. Record its id, source, and SHA-256 in the brief. Later phases read the
snapshot, not the live profile. With no clear match, work generic rather than
stretching a neighbouring domain onto this one.

Its acceptance criteria are candidates, not entries: account for every stable
criterion id, record accepted ones as success criteria and declined ones with a
reason, and treat one that needs a provider preflight could not see as a
question rather than a silent line — the same rule governing every other option.
Prioritize all candidate questions by plan impact and risk rather than asking
generic dimensions first mechanically.

An unknown that could alter scope, providers, dependencies, risk, or success
criteria may not enter planning. Universal dimensions cannot be assumed or
deferred. Defer only a profile-specific operational decision whose named future
gate cannot invalidate earlier planning; otherwise the brief is not approvable.

## Mode selection
When complete, show the brief and recommend `full` or `compact`, in the user's own language — the confirmed Chinese labels are `完整模式` and `尝试精简模式`. This card is non-authorizing, so it may carry the recommendation. `full` approves this brief and leads to survey plus separate plan review; `compact` records the preference, sets `mode-selected`, and assembles a no-probe bundle for one later approval. Offer revise and cancel; see [choice prompts](references/choice-prompts.md) for the portable card.
`full` is always selectable. `compact` is never forceable: show any known blocker; if assembly finds one, record `mode_upgrade_reason`, upgrade to `full`, and continue at its next gate without repeating mode selection. Record the recommendation, selection, and time.
When every dimension is closed, ask no discovery question; mode selection still occurs. An empty discovery log is valid only when all five universal dimensions cite the current request. Record the approval artifact before execution; selecting a mode never authorizes an unseen plan.
