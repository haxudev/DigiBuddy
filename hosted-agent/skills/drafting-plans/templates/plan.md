---
task_slug: <short-lowercase-hyphenated>
mode: compact | full | recovery
brief_revision: 1
capabilities_revision: 1
revision: 1
risk_tier: low | medium | high
created_at: <ISO-8601 timestamp>
profile_applied: n/a | <profile-id>@sha256:<64 lowercase hex recorded in brief.md>
recovery_handling: none | discard-and-restart | revalidate-untrusted-output
compact_approval_event: n/a | pending | <event-id>
compact_approval_at: n/a | <ISO-8601 timestamp>
status: draft | awaiting-approval | approved
approved_at: n/a | <ISO-8601 timestamp>
execution: not-authorized | authorized
authorized_at: n/a | <ISO-8601 timestamp>
---

# Plan: <task title>

## Status legend

`pending` | `running` | `completed` | `failed` | `skipped` | `blocked`

A step's status is not in this file. It is derived from `ledger.jsonl`, where
every boundary is appended as it happens, so an approved plan is never rewritten
to record what already occurred. Only `completed` and `skipped` are terminal:
`completed` needs a `step-completed` event after execution authorization, and
`skipped` needs a `step-skipped` event carrying the user's decision.

A step's `id` is its identity, and it is what the ledger names. Keep an id when
a revision keeps the same work; give new work a new id. A terminal result from
an earlier revision stands under this one only when the id and its ten contract
fields are unchanged, so reusing an id for different work would inherit a result
that describes something else.

## Profile coverage

One row per step-skeleton item and per known pitfall in the applied profile.
Deleting an item is fine and often right; leaving it unaccounted for is how a
pitfall the profile already named gets hit anyway. Write a single `n/a` row when
no profile applies.

| Profile item | Kind | Where it lands |
| --- | --- | --- |
| n/a | n/a | no profile applies |
| <stable item id> | skeleton / pitfall | <Step N, or Step N `verify`, or why it does not apply here> |

## Steps

### Step 1 - <imperative, specific>
- id         : <stable kebab-case id, unique in this plan>
- capability : <one of the fourteen>
- provider   : <confirmed provider or agreed manual/substitute handling>
- fallback   : <confirmed fallback>
- verify     : <named artifact or observable state>
- depends    : none
- risk       : low | medium | high
- operations : 1 | 2
- origin     : new-work | revalidation
- revalidates: n/a | <prior output identity from the ledger's recovery incident>
- retry-safe : yes | no

### Step 2 - <imperative, specific>
- id         : <stable kebab-case id, unique in this plan>
- capability : <one of the fourteen>
- provider   : <confirmed provider>
- fallback   : <confirmed fallback>
- verify     : <named artifact or observable state>
- depends    : Step 1 - <required output>
- risk       : low | medium | high
- operations : 1 | 2
- origin     : new-work | revalidation
- revalidates: n/a | <prior output identity from the ledger's recovery incident>
- retry-safe : yes | no

## Approval gates

| Before step | What happens | Cost/duration | Irreversible effect |
| --- | --- | --- | --- |
| Step N | <action> | <cost> | <effect, or none> |

## Known capability decisions

| Capability | Affected steps | Agreed handling | Effect on result |
| --- | --- | --- | --- |
| <capability> | Step N | manual / substitute / drop | <coverage effect> |

## Revision history

| Rev | Timestamp | Change | Why | User approval |
| --- | --- | --- | --- | --- |
| 1 | <ISO-8601 timestamp> | initial prospective plan | - | pending |
