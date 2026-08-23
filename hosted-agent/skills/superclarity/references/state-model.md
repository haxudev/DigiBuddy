# The state model

## Why state is evidence

Chat history is compacted and sessions end. A current snapshot alone is also
not enough: files written after execution can make unplanned work look as if it
had been approved in advance. State therefore comes from ordered artifacts and
their timestamps, not from memory or a status asserted after the fact.

## Layout

Everything lives under `.superclarity/` in the working directory.

```text
.superclarity/
  environment.md
  profiles/
  <task-slug>/
    profile.md
    brief.md
    capabilities.md
    plan.md
    ledger.jsonl
    report.md
    delivery-manifest.json
    data/
```

Use a short lowercase hyphenated slug. Never silently reuse a slug for a new
task; stale data plus a new brief creates a false history.

## Artifact contract

Control fields live in YAML frontmatter; everything below it is the document a
person reads and approves. Keeping them apart is what lets a field mean one
thing: `status: approved` with `approved_at` says the state and when it was
reached, where one prose line saying "approved by user at ..." had to be parsed
to answer either. A repeated key, or a line in the block that is not a key,
invalidates the whole block rather than letting a reader pick a copy.

Per-event and per-section values — a recovery incident's `Missing gate`, a
report's recovery disclosure — stay in the body, because there is one of them
per event rather than one per file.

| Artifact | Owns | Required control fields |
| --- | --- | --- |
| `environment.md` | cached provider readiness from a survey that probed | `surveyed_at`, OS, harness, relevant account/tenant |
| `profile.md` | immutable snapshot of the resolved profile used by this task | profile id, source, SHA-256 recorded in brief |
| `brief.md` | problem, outcome, scope, constraints, success | schema, mode, revision, explicit status and approval time |
| `capabilities.md` | need-to-provider bindings and agreed gap handling | brief revision, revision, status, survey time |
| `plan.md` | prospective steps and execution authority | revisions, creation, approval and authorization times |
| `ledger.jsonl` | when each artifact appeared, what happened, what was observed, and any incident | append-only events, each with `seq`, ISO `at`, and `kind` |
| `report.md` | delivery, evidence, coverage and gaps | plan revision, draft/final status and finalization time |
| `delivery-manifest.json` | external identity of the delivered bundle | schema, task, plan revision, report finalization and seal times, one SHA-256 per state-derivation input, project signature |

`environment.md` is the one row that belongs to no task. It is a cache and
nothing else: survey writes what it probed so the next task in the same context
need not probe again, and a task that probes nothing never creates it. Preflight
writes no file at all, because the visibility it establishes is re-read from the
session every time and is authoritative over anything a file remembers.

The ledger replaces four earlier artifacts — a journal, a recovery record, an
observations file, and a table of first-observed times — because they were one
thing pretending to be four. Each recorded when something became true about the
task, each was written by the agent with no integrity of its own, and one of
them was routinely written at the end from memory, which is exactly the evidence
it existed to rule out. An event appended into a file whose times may not go
backwards is harder to reconstruct afterwards than a table filled in at the end.
It is deliberately not hash-chained: appending a line must need nothing but the
agent's file tools, so that execution does not depend on a runtime this pack
requires only at delivery. See the owning skill's ledger-event grammar.

`delivery-manifest.json` replaces the report seal and the delivery proof for the
same reason. The seal was external so a report could not identify its own bytes;
the proof was closed so every input the `delivered` derivation read was covered.
One artifact outside every file it names, carrying one digest per input,
satisfies both — and two artifacts that must agree are two artifacts that can
disagree. It stays closed: an absent optional input is signed as `none` rather
than omitted, so adding one later invalidates it exactly as removing one does.
Anyone accepting it recomputes the whole manifest instead of re-deriving state,
so the manifest and the derivation cannot disagree.

When a profile applies, clarification validates the resolved regular file,
copies its exact content to task-local `profile.md`, then records its source and
SHA-256 in `brief.md`. Every later phase reads the snapshot, never the live
project, user, or packaged profile. Updating a live profile may shape the next
task; it may not rewrite what an already-approved task agreed to use.

Briefs and plans are drafted before approval. Their content may be revised only
with agreement; changing a brief invalidates capabilities, plan, and report,
while changing capabilities invalidates plan and report. Status updates do not
change plan content, and a step's status is not in the plan at all: it is
derived from the ledger, so an approved plan is not rewritten to record what has
already happened.

Once an artifact has passed the transition that consumed it — the brief its
approval, the survey its resolution, the plan its authorization — its content is
frozen at that instant. A later change is a new revision, which invalidates
everything downstream by the rule above. Editing the file in place instead is
refused whether or not it is honestly recorded: an observation appended past the
freeze shows the edit, and appending nothing leaves the latest recorded digest
describing bytes that are no longer there. There is no path on which a plan
keeps executing against a brief or a survey that changed underneath it.

All control timestamps use ISO 8601 with an offset or `Z`. A date without a
time cannot prove ordering and does not open a gate.

The persisted modes are `compact`, `full`, and `recovery`. Mode selection is a
shared decision, not an Agent verdict: at brief closure the Agent records an
evidence-based `compact` or `full` recommendation, explains both flows, and the
user selects one. This card is non-authorizing, so it may carry the
recommendation. It displays in the user's own language — the confirmed Chinese
labels are `完整模式` and `尝试精简模式` — for the persisted `full` and
`compact` values. `full` is always available. `compact` eligibility is not
negotiable, so a `compact` selection is a preference until the complete bundle
proves it; an ineligible attempt records its reason and upgrades to `full`
without asking the user to select a mode again.

Compact candidacy is not a fourth persisted mode or a durable state. It is the
router's pre-selection hypothesis for a new task that has no known Full or
recovery signal. A draft Compact bundle may test the user's Compact selection
using clarification already supplied by the requester and provider readiness
already visible in the session. The hypothesis becomes a valid Compact mode
only when the complete brief, capability map, and prospective plan prove all
Compact conditions. A finalized Full classification never downgrades.

Plan step count is evidence about the work, not a mode threshold. Steps are split
at provider, dependency, verification, and risk boundaries; combining those
boundaries to preserve Compact would make the plan less trustworthy. Compact
instead requires a bounded single-session plan whose steps are all low-risk and
reversible, whose providers are ready, and which has no mid-execution user gate
or known branch requiring replanning. A four-step plan can satisfy that contract;
a one-step plan with an unresolved provider or consequential effect cannot.

The five universal brief dimensions are `problem-current-state`,
`outcome-audience`, `scope-boundary`, `constraints`, and `success-criteria`.
Each must be `confirmed` with a basis beginning `request:`,
`discovery:<ID>:<ISO>:`, `volunteered:<ISO>:`, or `revision:<ISO>:`. They cannot
be assumed or deferred. A vague delegation
does not confirm one: the agent must present a concrete default and consequence,
then record the user's explicit acceptance as an answer. Profile dimensions may
be low-impact assumptions, or named deferred gates when the profile permits it.

The number of discovery prompts is derived from the brief's `Discovery log`, not
asserted beside it. An empty log is valid only when no required dimension cites
a prompt as its source; a `discovery:` basis must name a logged event that
covers that dimension. Volunteered information and user-initiated revisions are
user turns rather than prompts, so they carry their own prefix and no log row.
No fixed number of prompts is permitted or forbidden: a prompt is justified by
the blocking consequence its row records, and a decision already answered may
not be asked again.

`schema_version` moves forward only, and every earlier version keeps its own
rules. Schema 1 carries `discovery_prompts` and `budget_escalation` instead of a
discovery log; schema 2 has the log but the four separate evidence files, the
report seal and the delivery proof; schema 3 is the ledger bundle; schema 4 adds
revision-specific artifact observation, stable step identity, and authorization
binding; schema 5 adds the shared mode decision. Schemas 4 and later pair with
ledger schema `task-ledger/2`. A brief records the approvals a user gave, which cannot be
regenerated, so an old schema is read as it was written rather than being
rejected or rewritten, and a task that started under one schema finishes under
it. An earlier bundle is never reinterpreted under a later schema's rules, and a
missing digest is never backfilled from bytes nobody observed at the time.

Record each artifact's observation as a ledger `artifact` event when the file
appears. Missing observation closes the gate; embedded timestamps alone cannot
prove a file existed before work began. These events are inputs to derivation,
never reconstructed from the artifact's own control fields.

Schema 3 wrote that event once per file, which closed the one path that has to
stay open. A task whose `plan.md` already exists, and which then enters
recovery, must write a *later* plan after the resolution — but its single
observation was older than that plan's `created_at`, so the chronology check
failed and the task could not leave recovery however correctly it behaved.
Schema 4 therefore observes the revision rather than the file: `brief`,
`capabilities` and `plan` record `artifact` events carrying a revision number
and the SHA-256 of the bytes observed, with revisions starting at 1 and
incrementing by one. The revision in force is the one the file's own `revision`
field names, and the first event for that revision is what proves the revision
itself appeared.

A revision is not one set of bytes, so it is not one event. A brief is drafted
and then approved; a plan is drafted, approved, and then authorized, all under
revision 1. Each change appends another event with the same revision number,
and the latest one says which bytes that revision now means: it is the one that
must equal the file on disk. One event per revision whose digest had to match
the current bytes is unsatisfiable — the digest would have to cover bytes that
did not yet exist — and an append-only file cannot go back and correct it. A
revision may not go backwards or skip a number. `profile` and `report` keep one
observation each, because neither carries a revision.

A revision therefore keeps both times, because they answer different questions.
The first event says when the revision appeared and orders the artifact; the
latest says when those bytes were recorded. A snapshot is evidence about a
control transition only when it was taken at that transition's own instant:
earlier, its digest covers bytes that did not exist yet, and later, it covers an
edit the approval never saw. The brief's approved bytes are snapshotted at
`approved_at`, capabilities' resolved bytes at `surveyed_at`, and the plan's
approved bytes at `approved_at` — with a second snapshot of its authorized bytes
at `authorized_at`, carrying the same instant as its `plan-authorized` event,
because the transition from approved to authorized is the one content change an
approved revision may still make. The latest snapshot of the revision in force
must be that freeze, so nothing is appended for a revision afterwards.

Chronology checks route to whichever of the two times the artifact's own claim
actually names. A brief's `created_at` and a plan's `created_at` name the
draft, so each is ordered against its revision's first event. Capabilities'
`surveyed_at` names the resolution, not the draft that may have preceded it in
the same revision -- capabilities alone may sit as a draft or unresolved
snapshot before that resolution lands -- so `surveyed_at` is ordered against
the revision's latest event, the one that recorded the freeze. Checking it
against the first event instead would reject an ordinary walk from draft to
resolved within one revision, on a ledger that never went back and never
skipped ahead.

## Step identity across revisions

A revised plan used to reset every step, because a step event names its plan
revision and reconciliation skipped every other revision's events. That is safe
and wrong: it contradicts the rule that work already recorded under an earlier
revision is not repeated, and it makes every revision cost a re-run of
everything already finished — which is the pressure that produces a plan revised
to fit the work instead of the work replanned.

Inheriting by step number instead is worse. Revision 2 may renumber, and a
completion recorded for "Step 2" would land on whatever now occupies that
position, which is the one thing a prospective contract may never allow.

Schema 4 gives every step a stable `id`, unique within the plan and reused
across revisions only when it is the same work, and makes the ledger carry the
contract each id was authorized under. A `plan-authorized` event records the
SHA-256 of the plan revision it authorizes and one contract digest per step id:
the SHA-256 of that step's capability, provider, fallback, verification,
dependency, risk, operation count, origin, revalidation target and retry safety,
with the dependency named by the id it points at rather than by position. Step
events name the id, never the number.

A terminal result carries forward into a later revision only when the id is
present in both and the two contract digests are equal. Everything else starts
again: `running`, `failed` and `blocked` never carry forward, because they
describe an attempt rather than a result, and a later revision in which the id
was started again supersedes an earlier terminal result for it. A carried result
keeps the revision it was recorded under and is judged against that revision's
authorization, so nothing is re-recorded under a revision that did not witness
it.

Revisions are reconciled in order, each standing on what the ones before it
finished, and each judged against the contracts *it* was authorized under rather
than against the current plan's. Revision 1 finishes A; revision 2 carries A and
finishes B, which depends on A; revision 3 changes neither contract. Reading
carried results into the current revision alone leaves revision 2's history
judged against an empty terminal state, and a chain every revision authorized
honestly reads as a completion whose dependency never happened. What the earlier
folds may not do is launder anything: a changed contract still carries nothing,
and an earlier revision's provider binding and dependency order are still
checked wherever its contract shows the current plan describes the same work.

These digests fail closed. If the authorization for the current revision does
not list exactly the plan's step ids with the contract digests the plan file now
computes to, if it names a plan digest other than the one most recently observed
for that revision and recorded at that same instant, or if the latest recorded
digest for an artifact does not match the bytes on disk, the bundle is in
recovery. An authorization binds the bytes that exist when it is written, so an
authorized plan whose file has moved on since is in recovery too — the later
observation is refused outright rather than accepted as a record of the edit,
because nothing legitimate edits an authorized plan,
because its step status lives in the ledger and a revision is the only way to
change it. The ledger and the file disagree about what was approved, and neither
may be preferred silently.

## Two modes, the same gates

At brief closure, the mode card shows the Agent's recommendation and both
flows, displayed as `完整模式` and `尝试精简模式` and persisted as `full` and
`compact`. Selecting `full` approves the displayed brief and proceeds to
capability survey, then a separate plan review. Selecting `compact` starts
proposal assembly without approving an unseen plan; the matching brief,
capability map, and plan are approved in one later bundle review. `compact`
reduces turns, not preconditions: all three files must exist with matching
revisions before any task action. That bundle review grants the same authority
as the `full` plan review, so it too stays conservative-first with no
recommendation: approve-plan-only before approve-and-execute, then revise,
then Full review as its exit. One bundle answer may atomically approve all
three and authorize execution, but it must arrive first.

The `full` plan review grants authority the task did not already have, so it
stays conservative-first with no recommendation. In order: `批准计划`
(`approve-plan-only`), `批准并自动完成` (`approve-and-auto-execute`),
`修订计划` (`revise`), `取消` (`cancel`). `approve-and-auto-execute` writes
approval and authorization before acting, then continues through execution and
verification without routine confirmation. It pauses only for a declared
medium/high-risk gate, a change to scope, provider, dependencies, risk, or
success, an access/setup gap, an uncertain non-retry-safe effect, or a failure
whose viable paths require a user trade-off. "Ask less" never means guessing at
one of those boundaries.

## Order invariants

1. A Full selection approves the displayed brief; Full then performs no survey
   without that approval and writes no plan without resolved capabilities
   matching that revision.
2. A Compact selection may assemble matching brief, capability, and plan
   proposals before one atomic review, but may not probe, ask for setup, or
   perform task work. If assembly proves it ineligible, record the reason,
   upgrade to Full, and request the next Full gate rather than another mode
   choice.
3. No task action without an approved plan and explicit execution authorization.
4. No final report until every step is terminal and direct observations are
   bound to task slug, plan revision, time, and content identity. Finalization
   then writes `delivery-manifest.json` covering the report and every other
   input the derivation read; a delivered bundle whose current bytes do not
   match that external manifest is invalid.
5. Approval is prospective. A later approval never authorizes an earlier action.

`completed` and user-approved `skipped` are the only terminal step statuses. A
completed step records a ledger `step-completed` event no earlier than execution
authorization. A skipped step records a `step-skipped` event carrying the user's
decision. An editable line elsewhere without that event does not make a step
terminal.

A terminal result carried forward from an earlier revision keeps that earlier
event and is judged against that revision's authorization. It is never
re-recorded under the current revision: a second event for work that happened
once would date the work to a moment nobody witnessed it.

Its *verification* is not that event. Verification happens now, under whichever
revision is in force, so a carried step's verification observation may name the
current revision as well as the one that ran it, and is judged against that
revision's authorization either way. Accepting only the earlier revision asks
the verifier to date its own work to a revision it is not standing in, which no
honest agent can do, and the task verifies forever.

## Derived lifecycle

Apply the first matching row. Every predicate is observable from artifacts.

| State | Predicate |
| --- | --- |
| `paused` / `cancelled` | the brief explicitly records it with time and reason |
| `recovery-required` | the latest recovery event is an incident, a later artifact lacks a valid predecessor, revisions disagree, or work predates authorization |
| `new` | no task artifacts or task-work evidence exist, and this session's visibility has not been established |
| `preflight-required` | task artifacts form a valid prefix, but this session's visibility has not been established; re-read it without treating task history as invalid |
| `clarifying` | visibility is established and the brief is missing or `draft`; matching Compact proposal drafts may coexist when no task work exists |
| `awaiting-clarification-answer` | a draft brief records `Pending precedence` after contradictory answers |
| `awaiting-brief-approval` | a legacy brief awaits approval, or a Compact attempt upgraded to Full before brief approval |
| `awaiting-mode-selection` | a schema 5+ brief is complete and awaits the recommended mode choice |
| `assembling-compact` | the user selected a Compact attempt and its no-probe bundle is not complete |
| `awaiting-compact-approval` | a selected Compact brief has a complete matching capability map and plan awaiting atomic approval, with no task work |
| `surveying` | the brief is approved; capabilities are missing, draft, unresolved, or stale |
| `planning` | capabilities are resolved; the plan is missing or `draft` |
| `awaiting-plan-approval` | the plan status is `awaiting-approval` |
| `ready-to-run` | the plan is approved but execution is not authorized |
| `awaiting-user` | the first outstanding step is a running `ask-user` gate |
| `blocked` | the first outstanding step is `failed` or `blocked` |
| `executing` | execution is authorized and at least one step is non-terminal |
| `verifying` | every step is terminal and no finalized valid report plus matching delivery manifest exists |
| `delivered` | every step is terminal, `report.md` is finalized against the current plan revision, and the bundle's current bytes match `delivery-manifest.json` |

An empty or structurally incomplete approved artifact is invalid and leaves its
gate closed. A mere file's existence never opens a gate.

## Detecting out-of-order work

Later-phase evidence without its predecessor is not a harmless missing file.
Examples include `data/`, a ledger work event, plan, or report without an
approved brief; task work without resolved capabilities; or any task action
timestamp earlier than plan authorization. Use the earliest observable task-work
evidence: a ledger `step-started`, `step-completed` or `work` event, a produced
artifact, a known external action, or filesystem time when no stronger timestamp
exists.

An established session view is not such evidence. Preflight writes no file, and
the readiness cache holds no task content, so finding either without a brief is
the normal case rather than an incident.

When this occurs, enter `recovery-required`; never create earlier artifacts as
if they had existed. Append a `recovery-incident` event to the ledger and ask
the user to:

1. discard the prior output and restart;
2. adopt it only as untrusted input to explicit revalidation steps; or
3. stop the task.

Approval after the incident applies only to future work. A recovery plan lists
only remaining or revalidation steps, all initially `pending`; it never records
the old work as retrospectively `completed`. Capabilities describe the method
for future/revalidation work unless contemporaneous evidence proves what was
used. The final report discloses the incident and disposition.

A recovery resolution establishes a prospective baseline only when the brief,
capabilities, and a new plan are all reissued in `mode: recovery` after it, and
that plan references the resolution's assigned revision. Reissuing the plan
alone leaves the bundle in recovery: the brief is what records that this task is
now recovery work, and the capability survey describes the method that future
work will use. `stop` ends the task. Discard permits only new-work steps;
adoption requires revalidation steps. Retained output remains untrusted until
revalidated after authorization.

Under schema 4 and later each of the three must also record a new `artifact` revision
event dated after the resolution, so that "reissued" is observable rather than
asserted. This is also what lets a task that already had a plan leave recovery
at all: the new revision is observed on its own terms instead of being measured
against the moment the file first appeared. No terminal result crosses a
resolution, whatever its id and contract digest say. The incident is a finding
that the earlier work was never authorized, so inheriting it would launder
exactly what recovery exists to refuse.

## Resuming safely

Read `brief.md`, `capabilities.md`, `plan.md`, and the ledger's latest events
before selecting a task. If several tasks are open, or the current request could
be new, ask; always offer "start a new task". A merely similar request is not a
resumption.

For a step whose latest event is `step-started`, inspect its named evidence
first. If evidence proves completion, verify and append `step-completed`. If
not, redo only a retry-safe reversible step. For an irreversible or uncertain
effect, stop and ask; repeating it can perform the action twice.

## Volatile environments

If files cannot be written, say once that state is volatile. Use the same
artifact names as distinct conversation blocks, including statuses, revisions,
and timestamps. A logical block opens the same gate as its file equivalent;
restate current state at every checkpoint. Never claim the task is resumable.

## Sensitive material

Never store credentials, tokens, keys, passwords, or unnecessary personal data.
Ask users to authenticate themselves or provide a redacted export. Redact
secrets from errors, keep `data/` minimal, and warn before state may contain
sensitive material. Suggest ignoring `.superclarity/` before it is committed.
