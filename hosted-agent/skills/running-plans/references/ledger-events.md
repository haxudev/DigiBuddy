# Ledger events

One append-only JSONL file, `.superclarity/<task>/ledger.jsonl`, carries what
four files used to carry: the journal's boundaries, recovery's incidents, the
direct observations, and each artifact's first-observed time.

They were merged because they were one thing pretending to be four. All four
recorded *when something became true about this task*, all four were written by
the agent with no integrity protection of their own, and one of them — the
first-observed times — was routinely written at the end, from memory, which is
exactly the evidence it was supposed to rule out. An event that has to be
appended in order, into a file whose times may not go backwards, cannot be
reconstructed afterwards as comfortably.

## Line grammar

Every line is one JSON object. Never edit a line; append a correcting event that
names the earlier one. Never reorder or renumber.

- `seq` — 1 for the first line, then exactly one more each time.
- `at` — ISO 8601 with an offset or `Z`, never earlier than the previous line.
- `kind` — one of the kinds below, with that kind's fields.

Line 1 is always the task header, and no later line may be one:

```json
{"seq":1,"at":"2026-08-13T09:00:00Z","kind":"task","task":"vendor-review","schema":"task-ledger/1"}
```

`task-ledger/1` is the original grammar and is still read exactly as written.
New tasks open `task-ledger/2`, which pairs with `schema_version` 4 or later in
the brief. The two are read as one bundle: a `task-ledger/2` header beside an
earlier brief, or a revision-aware brief beside `task-ledger/1`, is a bundle
whose two readers disagree and the runtime refuses it.

```json
{"seq":1,"at":"2026-08-13T09:00:00Z","kind":"task","task":"vendor-review","schema":"task-ledger/2"}
```

## Kinds

| Kind | Fields | Written when |
| --- | --- | --- |
| `task` | `task`, `schema` | the ledger is created, before the first artifact |
| `artifact` | `artifact`: `profile` \| `brief` \| `capabilities` \| `plan` \| `report`; on `task-ledger/2` also `revision` and `digest` for `brief`, `capabilities`, `plan` | that file appears, and on `task-ledger/2` again whenever its bytes change |
| `plan-authorized` | `planRevision`; on `task-ledger/2` also `planDigest` and `steps[]` of `id`, `contract` | the user authorizes execution of that plan revision |
| `step-started` | `planRevision`, `step` (`id` on `task-ledger/2`), `provider` | immediately before acting on a step |
| `step-completed` | `planRevision`, `step` (`id`), `evidence` | the `verify` line was checked against reality |
| `step-skipped` | `planRevision`, `step` (`id`), `decision` | the user agreed to skip it |
| `step-failed` | `planRevision`, `step` (`id`), `diagnosis`: `configuration` \| `input` \| `external`, `detail` | an action failed and was diagnosed |
| `step-blocked` | `planRevision`, `step` (`id`), `detail` | the step cannot proceed without a decision |
| `observation` | `observed`: `artifact` \| `claim` \| `verification` \| `criterion`, `ref`, `planRevision`, `contentUpdatedAt`, `contentDigest` | verification opened the thing itself |
| `recovery-incident` | `missingGate`, `outputs[]` of `output`, `evidenceAt`, `effect`, `why` | work is found that predates its gate |
| `recovery-resolution` | `decision`, `planRevision` (`null` for `stop`), `consequences` | the user chose a disposition |
| `work` | `detail` | a task action happened outside any plan step |
| `note` | `topic`: `progress` \| `deviation` \| `assumption` \| `correction` \| `decision`, `detail` | anything worth reading later that changes nothing |
| `repair` | `discarded`, `reason` | an interrupted append left an unreadable line |

`missingGate` is one of `brief approval`, `capability resolution`,
`plan approval`, `execution authorization`. A recovery `decision` is one of
`discard and restart`, `adopt as untrusted input and revalidate`, `stop`. These
are matched exactly; a natural-language description of the same thing leaves the
task in recovery.

## What each kind is for

**Artifact events are the chronology.** `at` is when the file appeared, so the
file's own `created_at` is at or before it. An artifact present without its
event closes every later gate, because an embedded timestamp cannot prove a file
existed before work began.

On `task-ledger/1` there is exactly one such event per file, which is why a task
that already had a plan could never leave recovery: the recovery plan has to be
written *after* the resolution, and its one observation was older than that. On
`task-ledger/2` the chronology is per revision. `brief`, `capabilities` and
`plan` carry a `revision`, numbered from 1 and incrementing by one; the first
event for a revision is when that revision appeared, and it is what orders the
artifact.

A revision is not one set of bytes, so it is not one event either. A brief is
drafted and then approved; a plan is drafted, approved, and then authorized —
all under revision 1. Append another event with the *same* revision each time
the file changes, carrying the SHA-256 of the bytes as they then stand. The
latest event for a revision is what says which bytes that revision now means,
and it must equal the file on disk. One event per revision whose digest had to
match the current bytes was a rule no honest task could satisfy: the digest
would have to cover bytes that did not exist when the line was written.

A revision therefore keeps two times, and they answer different questions. The
*first* event for a revision is when that revision appeared, and it orders the
artifact and nothing else. The *latest* event is when those bytes were last
recorded, and it is the one a gate reads.

A snapshot is evidence about a control transition only when it was taken at that
transition's own instant. Recorded earlier, its digest covers bytes that did not
exist yet — a claim about the future written by the same agent at a moment the
user had agreed to nothing. Recorded later, it covers an edit the approval never
saw. So the freeze is exact:

| Artifact | Bytes | `at` must equal |
| --- | --- | --- |
| `brief` | as approved | the brief's `approved_at` |
| `capabilities` | as resolved | the survey's `surveyed_at` |
| `plan` | as approved | the plan's `approved_at` |
| `plan` | as authorized | the plan's `authorized_at`, and its `plan-authorized` |

The latest snapshot of the revision in force must be that one, so nothing is
appended for a revision after its freeze. Once frozen, content changes need a
new revision — which is what invalidates capabilities, plan and report when a
brief changes, and plan and report when capabilities change. Editing the file in
place instead puts the task in recovery whether or not a new snapshot is
honestly appended: with one, the record shows an edit past the freeze; without
one, the latest digest no longer matches the bytes on disk. An approved plan is
the single exception, and only for the one control transition it has left: it
takes a second snapshot at `authorized_at`, so its approved bytes keep a
snapshot of their own immediately before it.

A revision may never go backwards or skip a number, and `profile` and `report`
carry no revision, so they keep one event each.

```json
{"seq":9,"at":"2026-08-13T16:00:00Z","kind":"artifact","artifact":"plan","revision":2,"digest":"sha256:<64 hex>"}
```

**Authorization and step events are the status.** The plan does not record it.
Every one of them names the plan revision it belongs to: without that, a
completion recorded under revision 1 silently becomes a completion of whatever
revision 2 renumbered into that position, and honest earlier work starts looking
unauthorized the moment a revision is authorized later. Each revision gets its
own `plan-authorized` event, and it must carry the same instant as that
revision's `authorized_at`.

On `task-ledger/2` the authorization also binds what it approved. It carries
`planDigest`, which must equal the digest most recently observed for that
revision, recorded at this same instant — an authorization binds the bytes that
exist where it stands, never the ones the file becomes later, and never bytes
snapshotted an hour before they existed — and one `steps` entry per plan
step: the step's stable `id` and
`contract`, the SHA-256 of the ten contract fields joined as
`capability`, `provider`, `fallback`, `verify`, `depends`, `risk`,
`operations`, `origin`, `revalidates`, `retry-safe` — one `<name>:<value>` per
line in that order, with `depends` rewritten to name the step id it points at
instead of its position, so renumbering alone does not change a contract while a
changed dependency does.

```json
{"seq":10,"at":"2026-08-13T17:00:00Z","kind":"plan-authorized","planRevision":2,"planDigest":"sha256:<64 hex>","steps":[{"id":"gather-pricing","contract":"sha256:<64 hex>"}]}
{"seq":11,"at":"2026-08-13T17:30:00Z","kind":"step-started","planRevision":2,"id":"compare-vendors","provider":"research-provider"}
```

This is what makes a revision cheap without making it dishonest. A terminal
result recorded for an id under an earlier revision still stands under a later
one when both authorizations record the same contract digest for that id;
`running`, `failed` and `blocked` never carry, and a later revision that started
the id again supersedes the earlier result. If the current revision's
authorization does not list exactly the plan's ids with the digests the plan
file now computes to, the ledger and the plan disagree and the task is in
recovery rather than executing on whichever the reader preferred.

A step's events are reconciled against the approved plan, not merely shaped:
the step must exist in that revision, `step-started` must name the step's bound
provider or its stated fallback, nothing may finish, fail, or block before it
has started, and nothing may finish before the step it depends on has. A
mistaken terminal event is corrected by starting the step again and recording
the real outcome — never by editing the line.

Nothing legitimate edits a plan once it is authorized: its step status lives in
these events, so a revision is the only way to change it. An `artifact` event
for a plan revision that is already authorized is therefore refused outright,
however honestly it was appended, and a file that moved on without one fails the
digest check instead: either way the file and the approval have become two
documents, and neither may be preferred silently.

**Observation events are the evidence.** They carry the digest and the content
time so that a report row points at something that was actually opened. An
observation of a revision cannot predate that revision's authorization, and no
observation may name a revision the plan never reached. A step carried from an
earlier revision may be verified under either that revision or the current one:
verification happens now, in whichever revision is in force, and requiring the
earlier one would ask the verifier to date its own work to a revision it is not
standing in — leaving the task verifying forever.

Revisions are folded in order, each standing on what the ones before it
finished. Revision 1 finishes A, revision 2 carries A and finishes B on top of
it, revision 3 changes neither contract: all three folds have to see the history
that was available to them, or a chain every revision authorized honestly reads
as a completion whose dependency never happened.

**Recovery events are the incident record.** An incident opens recovery and a
resolution closes it; after a `stop`, only a `note` or a `repair` may follow.
They are ordinary events in the same file, so an incident can never be quietly
written before the work it covers.

**Work and note events are the rest of the story.** `work` is what makes
unplanned action visible; `note` is the diagnosis, deviation, assumption, or
correction that a later reader needs and no parser reads.

## When an append is interrupted

A half-written line is the ordinary way an append dies. Skipping it silently
would shorten the history the file exists to preserve, and refusing it forever
would mean one interrupted write could never be resumed, cancelled, or even
recovered. So there is exactly one way past it, and it stays on the record:
append a newline to terminate the broken line, then append a `repair` event
whose `discarded` is that line's text verbatim.

```json
{"seq":12,"at":"2026-08-13T15:00:00Z","kind":"repair","discarded":"{\"seq\":12,\"at\":\"2026-08","reason":"append interrupted"}
```

Anything else — editing the line, deleting it, renumbering around it — leaves a
history nobody can audit, and the reader refuses the whole file rather than
guess which lines were lost.

Redact secrets before appending. This file is append-only, so a credential
written into it is a credential that stays written.
