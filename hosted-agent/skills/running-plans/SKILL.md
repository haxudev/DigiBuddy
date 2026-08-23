---
name: running-plans
description: Executes a current approved plan only after explicit authorization, verifying every step and recording boundaries without scope drift. Use when plan.md is approved and the user authorized starting (开始 / 执行 / 跑吧 / 继续 / 动手). Uses bound providers and fallbacks, stops after two unchanged failures, and re-gates deviations instead of improvising. Appends events to .superclarity/<task>/ledger.jsonl. Do NOT use without matching brief/capability revisions and execution authorization, for retrospective completion records, or to expand scope.
license: MIT
metadata:
  pack: superclarity
  phase: execute
---

# Execute without rewriting history

Answer in the user's language.

## Preflight

Before every start or resume, require:

- approved brief and resolved capabilities matching plan revisions;
- approved plan with `execution: authorized` and its `authorized_at` time;
- no open recovery incident; any resolution has a later matching recovery plan
  and a disposition other than stop;
- no unhandled task-work evidence predating authorization.

If any check fails, do not act. Enter the earlier phase or recovery. A user
saying "continue" authorizes only a valid current plan, not missing history.

When recovery is needed, the incident and its resolution are ledger events, not
a separate file: an incident recorded in the same ordered stream as the work it
covers cannot be quietly written before that work.

## Per-step loop

1. Select the first dependency-ready non-terminal step. Its status is whatever
   the ledger's latest event for it says, never what the plan file says.
2. Append `step-started` with the bound provider before acting.
3. Use that provider; do not substitute outside its fallback.
4. Check reality against the exact `verify` line and open produced artifacts.
5. On success, append `step-completed` naming the evidence, then a `progress`
   note for what you learned and what surprised you.

Every step event names the plan revision it belongs to, and must fall at or
after that revision's `plan-authorized` event. One JSON object per line, `seq`
counting up from 1, `at` never going backwards:

```json
{"seq":<next>,"at":"<ISO>","kind":"step-started","planRevision":1,"id":"<step id>","provider":"<bound>"}
{"seq":<next>,"at":"<ISO>","kind":"step-completed","planRevision":1,"id":"<step id>","evidence":"<named>"}
```

A step is named by its stable `id`, never by its position, because a revision
may renumber and a completion that landed on a position would then describe
different work. A task opened on `task-ledger/1` keeps `"step":<n>` instead.

A step's status lives only in these events. The plan is not edited to record
what happened, so an approved plan cannot quietly become a description of the
work instead of a contract for it.

A successful tool return proves only that it ran. Completion requires the named
evidence after authorization.

## Failure

Use the planned fallback. If it is unavailable, stop and append `step-blocked`.
Two unchanged failures of the same action require diagnosis before another
attempt: append `step-failed` with `configuration`, `input`, or `external` and
what you saw. Give viable options and an evidence-supported recommendation; if
evidence favors none, say that rather than steering.

Do not record failure as `step-skipped`. Skipping needs an explicit user
decision recorded in that event, plus the effect on coverage.

## Deviations

When scope, provider, dependencies, risk, or success assumptions change, stop.
Offer two or three plan revisions with consequences, obtain agreement, update
the owning upstream artifact first, then reapprove invalidated downstream
artifacts. Never broaden or reduce scope silently.

An upstream artifact is frozen once it is approved or resolved, so updating it
means a new revision of it, never an edit in place. Editing the approved brief
or the resolved survey underneath an authorized plan puts the task into
recovery — with an honest new observation or without one — because the plan was
approved against bytes that no longer exist.

Stop executing before the new revision is written, not after. Once it is
approved and its `plan-authorized` event binds the new plan digest and every
step's contract digest, resume at the first non-terminal step. A step keeps its
terminal result from any earlier revision when its `id` and its ten contract
fields are unchanged — revisions are read in order, so work built on an earlier
revision's result keeps both — while a new id, a changed contract, or an attempt
left running, failed, or blocked starts again as pending. Nothing carries across
a recovery resolution.

If Compact discovers a capability gap, login/install, sensitive data, external
effect, a mid-execution decision, a known replanning branch, work that no longer
fits one session, or higher risk, upgrade to Full before acting. Step count
alone never triggers an upgrade, and steps must not be merged to avoid one.

## Questions and long work

Continuous authorization means run ordinary steps and verification without
asking again. Pause only for a planned medium/high-risk gate, a change to scope,
provider, dependencies, risk, or success, an access/setup gap, an uncertain
non-retry-safe effect, or a diagnosed failure whose viable paths require the
user to choose. Reporting progress, including yielding during long work, is
never itself an approval gate and never needs an answer before continuing.

At an `ask-user` step, summarize done/next/changed, ask once, append
`step-started`, and end the turn. Anything performed after asking rests on a
guessed answer.

Before work lasting more than a few minutes, state that it started and how
progress can be checked, then yield unless the user explicitly asks you to wait.

## Interruption

A `step-started` with no later event for that step says only that it started.
Inspect its named evidence. If that proves completion, verify and append
`step-completed`. If evidence is absent, redo only when `retry-safe: yes` and
the action is reversible. Otherwise state what may have happened and ask;
repeating an uncertain irreversible action can perform it twice. A record you
got wrong is corrected by starting the step again and recording the real
outcome, never by editing a line.

## Ledger

Append to [`ledger.jsonl`](templates/ledger.jsonl) at every start and boundary,
following [the event grammar](references/ledger-events.md). Never edit a line;
append a correcting event that names the earlier one. If an append is
interrupted and leaves an unreadable line, terminate it with a newline and
append a `repair` event quoting the discarded text verbatim — that is the only
way past it, and the loss stays on the record. Redact secrets before appending:
the file is append-only, so a credential written into it stays written.

Task work outside any plan step is a `work` event, and finding one before
authorization is what makes unplanned action visible. Never append events or
terminal step results to imply this plan governed work that occurred before its
authorization.

## A task that predates the ledger

A task whose brief carries a `schema_version` below 3 finishes the way it
started, because its approvals cannot be recreated. Read the number, not the
absence of one line: 4 is not 3 either, and treating a later schema as
pre-ledger would strand a current task. Keep its step `status`, `verified-at`
and `skip-approved` lines inside `plan.md`, keep appending to `journal.md`,
and do not create `ledger.jsonl` — a ledger beside an older brief is a bundle
whose two readers disagree, and the runtime refuses it.
