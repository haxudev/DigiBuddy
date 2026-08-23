---
name: distilling-lessons
description: Promotes lesson candidates from delivered tasks into a domain profile, one approved diff at a time (沉淀经验 / 复盘 / 总结一下 / 更新剧本 / 把这次的教训记下来 / distil lessons). Requires sealed final reports, independent sources or an explicit override, runtime profile validation, and a locked SHA-256 transaction. Writes project or deliberately widened user-global profiles, never packaged profiles or dimensions. Do NOT use without sealed evidence, to invent lessons from memory, while the target is unsafe to update, or inside a task plan — delivered stays terminal.
license: MIT
compatibility: Requires Node.js 20.10 or newer for locked profile transactions.
metadata:
  pack: superclarity
  phase: maintenance
---

# A profile earns its next line from evidence, not from memory

Most lesson candidates are true of one task and nothing else. Promoting all of
them turns a profile into a diary; promoting none wastes the only record of
what the domain actually turned out to be.

This is maintenance, not a phase. The source task stays delivered. Answer in
the user's language.

## Fail closed first

Before proposing anything, confirm:

- every source is a finalized report whose external delivery manifest still
  matches every input the derivation read;
- the complete source bundle still derives as `delivered`, including approvals,
  revisions, terminal steps, observations, and the matching manifest;
- each source identifies project, task, plan revision, candidate, and time;
- an existing target is a validated regular file inside an allowed profile
  root, or an initialization target is absent under the lock;
- the scope's event ledger and exclusive write lock are available.

A draft or changed report is not verified evidence. A malformed, linked, or
out-of-root profile is not domain knowledge; opening it would make profile
resolution an arbitrary file read.

## Identify a source, not a name

A task slug is local and reusable. Source identity is project id, task slug,
plan revision, report finalization time, sealed report SHA-256, and candidate id.
Re-reading one source changes nothing.

Two independent sources make a candidate eligible to propose, never authorized
to write. Show every source so the user decides whether they are genuinely
independent. One source may be promoted early only with an explicit reason and
an explanation of what a second observation would have established.

## Propose, then transact

Show the exact diff first: lesson wording, target stable item id, sources, and
anything displaced to stay inside the line budget. Approval names that exact
diff, not a general permission to improve the profile.

Record the user's decision as an approval receipt shaped by
[`approval-receipt.json`](templates/approval-receipt.json); `approve` reads that
file and rejects any diff, result digest, or content that differs from proposal.

Read [the maintenance transaction](references/transaction.md) before any write.
It owns initialization, immutable events, scope-specific locking, SHA-256
comparison, atomic replacement, crash recovery, and guarded rollback. A read-then-write
check without the lock is not concurrency control.

Run [`profile-transaction-cli.mjs`](scripts/profile-transaction-cli.mjs) for
source verification, proposal, approval, apply, rollback, and lock recovery.
Never edit a live profile or ledger directly; doing so bypasses the exact-diff
approval and transaction boundary this skill exists to provide.

## Initialize before promotion

When the target scope has no profile but a lower scope does, fork the complete
resolved file and record its source and SHA-256 lineage. Do not apply a lesson
in the same transaction: accepting the fork and accepting the lesson are
different decisions.

When no profile resolves, initialize from the blank template in a separate
approval. A valid profile needs user-approved dimensions; lesson promotion may
not invent them. Only a later transaction may promote a candidate.

Packaged profiles are read-only. Project writes go to
`.superclarity/profiles/<profile-id>.md`; user-global writes go to
`~/.superclarity/profiles/<profile-id>.md`.

## Widening beyond the project

Promote user-global only when the complete resulting profile, including its id,
can be reviewed without exposing a client, vendor, system, dataset, person,
unique metric, or confidential value. If it cannot, it describes one engagement
rather than the domain.

Ask before the first user-global write and name what becomes visible to
unrelated projects. To share with a team, track only
`.superclarity/profiles/`; task state beside it can contain task material.

## Keep the profile a working reference

At 120 lines, propose a merge or replacement and name what is displaced; never
truncate silently. Every skeleton item, criterion, and pitfall has a stable id,
so a later lesson supersedes a named item instead of contradicting mutable prose.

Dimensions are never promoted here. Park such a candidate as
`needs-dimension-change`, name the affected tasks, and stop. The user changes
dimensions in a separately approved profile initialization/revision.

## Immutable evidence

The ledger is append-only JSONL, one event shaped by
[the event template](templates/ledger-event.json). Project events live under
`.superclarity/learning/`; user-global events under
`~/.superclarity/learning/`. Keep them out of `profiles/`, where anything is
selectable. A rejection without an event returns after the next delivery.
