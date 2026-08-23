# Profile maintenance transaction

The executable interface is
[`profile-transaction-cli.mjs`](../scripts/profile-transaction-cli.mjs). Each
command reads one JSON input file and emits JSON. Do not recreate these steps
with ad-hoc file writes.

`verify-source` is the only way to create a source accepted by `propose`. The
verifier already refused to seal a bundle that was not ready to deliver, so
re-deriving that state here would only duplicate it with a second, weaker
reader. Instead this recomputes the delivery manifest's closed set — profile
snapshot, brief, capabilities, plan, ledger, and report — checks the keyed
signature, and takes plan revision and report finalization time from the signed
payload. Any byte that changed since sealing, in any input the derivation read,
fails here. A bundle sealed before the ledger existed is recomputed against its
own older set, which additionally covered the report seal, recovery file,
observations, and artifact times; its approvals cannot be recreated, so it keeps
the reader it was written for.

This protects workflow integrity against accidental or agent-authored rewrites;
it is not a security boundary against a local user who can edit both task files
and project verification keys. Filesystem access at that level can replace the
entire workflow. User-global writes therefore remain explicitly approved even
when the source proof is valid.

## Initialize or fork before promotion

A lesson cannot create a valid profile by itself: a profile needs at least one
user-approved dimension, while lesson promotion is forbidden from inventing or
changing dimensions. Keep initialization and promotion as separate approvals.

If a profile already resolves from `user` or `built-in` and the target scope
does not yet contain it, initialize by forking the complete resolved file. The
fork retains every stable item id and records its lineage as
`<source>:<profile-id>@sha256:<digest>` in `Base profile`. Apply no lesson in the
same transaction; otherwise the user cannot distinguish accepting the fork
from accepting the lesson.

If no profile resolves, initialize from the blank profile template. The user
must approve its dimensions, deferrable subset, skeleton, criteria, and
pitfalls as one new-profile proposal. Record `Base profile: none`. Only a later
transaction may promote a lesson into it.

## Immutable ledger

Use newline-delimited JSON at `<learning-root>/<profile-id>/events.jsonl`. Each
line is one immutable event shaped like the template in
`templates/ledger-event.json`. Never edit a prior line or keep mutable summary
fields. Every event hashes the complete preceding event and itself, and a
separate atomically replaced `.head` file anchors the expected tail; reject a
broken or truncated chain before reading state. Current state is a fold over
events in order:

1. `candidate-created` defines the candidate and its first source.
2. `source-added` adds a source identity not already present.
3. `proposal-created` or `initialization-proposal` computes and records canonical diff plus before/after bytes.
4. `approved` or `rejected` references that exact proposal and user decision.
5. `prepared` records the approved transaction before the profile write.
6. `applied` references and commits the prepared event after the profile write.
7. `rolled-back` references the latest effective applied event.
8. `aborted` references a prepared event that recovery proved was not applied.

An event id and candidate id use 128 bits of randomness. On the first project
state write, generate and persist a random UUID in `.superclarity/project-id`;
never derive it from a path, repository URL, client, or tenant. A project source
identity is `project_id + task_slug + plan_revision + report_finalized_at +
report_sha256 + report_candidate_id`, so rereading one candidate is idempotent.

A user-global event must not copy task slugs or candidate ids across the
project boundary. Store only `source_ref = HMAC-SHA-256(user learning secret,
full project source identity)` there; keep the detailed source event in the
project ledger. Review the complete global event payload for client material,
not only the resulting profile.

## Transaction boundary

The profile and ledger are two files, so one rename cannot make both atomic.
Use a scope-specific exclusive lock and a write-ahead event instead:

1. Acquire `<learning-root>/<profile-id>/write.lock` exclusively.
2. Under the lock, either re-read and SHA-256 the target against the approved
   base digest, or for initialization prove the target still does not exist and
   require `base_sha256: none`.
3. Validate the complete proposed profile.
4. Append and flush `prepared`, including exact before/after content and diff.
5. Write the proposed profile to a sibling temporary file, flush it, and rename
   it over the target.
6. Append and flush `applied`, then remove the lock.

If a crash leaves `prepared` without `applied`, compare the current profile
digest with that event's before and after digests. Append `applied` when the
after digest is present; append `aborted` when the before
digest is present; stop on any third value. Never guess.

Rollback also acquires the lock. It is permitted only when the named applied
event is the latest effective write and the current SHA-256 equals that event's
result digest. Otherwise create a new compensating proposal and obtain a new
approval; restoring old bytes over later work is not rollback, it is data loss.

Project writes use `.superclarity/learning/`; user-global writes use
`~/.superclarity/learning/`. The ledger, lock, rejection memory, and rollback
history always live in the same scope as the profile they govern.
