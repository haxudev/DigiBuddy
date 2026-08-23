---
schema_version: 5
task_slug: <short-lowercase-hyphenated>
mode: compact | full | recovery
revision: 1
created_at: <ISO-8601 timestamp>
risk_tier: low | medium | high
mode_recommendation: compact | full | n/a
mode_selection: pending | compact | full | n/a
mode_selected_at: n/a | <ISO-8601 timestamp>
mode_upgrade_reason: n/a | <why the Compact attempt became Full>
profile: <profile-id, or "none - generic">
profile_dimensions: none | <comma-separated kebab-case dimensions required by the profile>
profile_source: n/a | built-in | user | project
profile_digest: n/a | sha256:<64 lowercase hex of task-local profile.md>
compact_basis: n/a | new, no-conflict, reversible, one-session, no-money, no-sensitive-data, no-external-effect, no-consequential-deliverable, clarity-closed
compact_approval_event: n/a | pending | <event-id>
compact_approval_at: n/a | <ISO-8601 timestamp>
pending_precedence: none | <decision>: <earlier answer> <> <latest answer>
status: draft | mode-selected | awaiting-approval | approved | paused | cancelled
approved_at: n/a | <ISO-8601 timestamp>
stopped_at: n/a | <ISO-8601 timestamp the task was paused or cancelled>
stop_reason: n/a | <why it was paused or cancelled>
---

# Brief: <task title>

## Problem and current state

What is happening now, what evidence makes it a problem, and why change is
needed. Use "not applicable - request is a direct deliverable" when appropriate.

## Outcome and audience

What this produces, who consumes it, and what decision or use it supports.

## In scope

- <specific, checkable item>

## Out of scope

- <explicit exclusion and why>

## Constraints

| Constraint | Value |
| --- | --- |
| Deadline | <timestamp/date, or none> |
| Budget or effort ceiling | <limit, or none> |
| Required output format | <format> |
| Permitted sources | <sources> |
| Access and exposure limits | <systems/data off limits> |

## Success criteria

- [ ] <criterion checkable by an uninvolved person>

A profile's acceptance criteria are candidates, not entries. List one here only
after the user accepted it. Account for every stable criterion id below; a
criterion needing a provider preflight could not see is a question, never a
silent line.

## Profile criteria decisions

| Profile criterion | Decision | Brief criterion or reason |
| --- | --- | --- |
| n/a | n/a | no profile applies |
| <criterion-id> | accepted / declined | <exact accepted criterion, or reason declined> |

## Assumptions

Only low-impact profile dimensions belong here. Universal dimensions cannot be
assumed.

| # | Dimension | Assumption | Impact | If wrong |
| --- | --- | --- | --- | --- |
| A1 | <dimension from closure> | <disclosed default> | low | <what changes> |

## Capability decisions

Only agreed decisions from survey. If one changes scope, constraints, or success,
increment this brief's revision and obtain approval again.

| Gap | Decision | Effect on result |
| --- | --- | --- |
| <capability> | manual / substitute / drop | <coverage effect> |

## Deferred gates

Only operational decisions that cannot change approved scope, providers,
dependencies, risk, or success criteria.

- <decision> - settle before <step>; safe to defer because <reason>

## Discovery log

One row per discovery prompt, in the order asked, written before the question is
put and updated once the answer arrives. There is no limit on rows; a prompt
earns its place by naming what stays blocked without it. Approval, information
the user volunteered, and a revision the user started are not discovery prompts
and never appear here.

Say "No discovery prompts - the request settled every required dimension." and
leave the table empty when nothing needed asking.

| ID | Revision | Trigger | Affected decisions | Blocking consequence | Asked at | Outcome |
| --- | --- | --- | --- | --- | --- | --- |
| Q1 | 1 | request-silent | <required dimension, profile-selection, or precedence> | <what cannot be planned until this is settled> | <ISO-8601 timestamp> | pending |

Triggers: `request-silent`, `contradiction`, `profile-selection`,
`option-infeasible`, `vague-delegation`. Outcomes: `pending`, `answered`,
`partial`, `contradicted`, `withdrawn`. Re-ask a decision only after `partial`,
`contradicted`, or `withdrawn`.

## Clarification closure

List every universal and profile-required dimension. Universal dimensions must
be `confirmed`, with a basis beginning `request:`, `discovery:<ID>:<ISO>:`,
`volunteered:<ISO>:`, or `revision:<ISO>:`. A `discovery:` basis must name a row
above whose affected decisions include this dimension. For profile dimensions,
`assumed` must be low impact and `deferred-operational` is valid only when the
profile permits it and the named gate cannot change scope, provider,
dependencies, risk, or success criteria.

| Dimension | Disposition | Impact | Basis or named gate | Plan impact |
| --- | --- | --- | --- | --- |
| problem-current-state | confirmed | none | request: <evidence> / discovery:Q1:<ISO timestamp>: <evidence> | none |
| outcome-audience | confirmed | none | request: <evidence> / discovery:Q1:<ISO timestamp>: <evidence> | none |
| scope-boundary | confirmed | none | request: <evidence> / volunteered:<ISO timestamp>: <evidence> | none |
| constraints | confirmed | none | request: <evidence> / discovery:Q1:<ISO timestamp>: <evidence> | none |
| success-criteria | confirmed | none | request: <evidence> / revision:<ISO timestamp>: <evidence> | none |
| <profile dimension> | confirmed / assumed / deferred-operational | none / low | <sourced basis, assumption, or named gate> | none |
