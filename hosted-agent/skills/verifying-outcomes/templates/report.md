---
task_slug: <short-lowercase-hyphenated>
plan_revision: 1
created_at: <ISO-8601 timestamp>
status: draft | finalized-complete | finalized-partial
finalized_at: n/a | <ISO-8601 timestamp>
---

# Report: <task title>

## What was delivered

| Artifact | Location | Purpose | Observed at | Content identity |
| --- | --- | --- | --- | --- |
| <name> | <path> | <decision or use supported> | <ISO-8601 timestamp> | <digest or stable fingerprint> |

## Coverage

| Dimension | Covered | Intended | Note |
| --- | --- | --- | --- |
| <dimension> | <measured extent> | <target> | <difference> |

## Gaps and what they mean

| Not covered | Why | Effect on conclusions |
| --- | --- | --- |
| <gap> | <cause> | <what cannot be concluded or possible bias> |

Never restate "not observed" as "does not exist".

## Success criteria

| Criterion | Met | Evidence | Observed at | Content identity |
| --- | --- | --- | --- | --- |
| <brief criterion> | yes / no / partial | <named current evidence> | <ISO-8601 timestamp> | <digest or stable fingerprint> |

## Evidence trail

| Claim | Evidence | Observed at | Content identity |
| --- | --- | --- | --- |
| <claim> | <file, URL, observation, or computation> | <ISO-8601 timestamp> | <digest or stable fingerprint> |

## Assumptions surviving delivery

| Assumption | If wrong | Affects |
| --- | --- | --- |
| <assumption> | <change> | <conclusion> |

## Recovery disclosure

- **Incident:** none | <reference to the ledger.jsonl recovery events>
- **Disposition:** <discarded / revalidated / stopped>
- **Revalidation evidence:** <authorized plan step and artifact, or n/a>

## What would close the gaps

- <action> - closes <gap>, needs <capability/access>, roughly <effort>

## Reusable lesson candidates

Domain lessons only, restated in your own words, redacted here rather than
later. Write `none` when nothing generalises — most tasks teach nothing new.

| Candidate | Target | Lesson | Applies when | Evidence |
| --- | --- | --- | --- | --- |
| L1 | pitfall / acceptance / skeleton | <what to do differently, in domain terms> | <the condition that makes it true> | <ledger event timestamp, or a row above> |

Write the literal `none` instead of the table when nothing generalises. The
section is mandatory; its outcome is not.
