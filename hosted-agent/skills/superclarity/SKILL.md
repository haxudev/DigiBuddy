---
name: superclarity
description: Routes multi-step, long-running, or consequential work through clarification, local capability resolution, planning, authorized execution, and evidence-based verification. Use first for planning requests (规划 / 计划 / 做个方案 / 拆解一下 / 怎么做), resumed work (继续 / 接着做 / 上次做到哪了), and tasks involving money, sensitive data, irreversible or external actions, submission or publication, third-party deliverables, or important-decision outputs, regardless of step count. If any activation signal is unknown, route here. Selects Compact for bounded low-risk work and Full otherwise; neither acts before approval. Explicit invocation always routes through these gates. Do NOT use for automatic invocation on plain factual questions, coding-specific methodology, or reversible local requests that are neither multi-step nor long-running and have no consequential signal.
license: MIT
metadata:
  pack: superclarity
  phase: router
---

# Route the work, preserve the order

Long tasks fail at seams: work starts before intent is agreed, plans assume a
missing tool, or later files make unplanned work look authorized. This skill
guards both gates and chronology.

## Enter here

When loaded, route here before discovery or action. Lesson review or promotion
routes directly to `distilling-lessons`, outside task phases. Otherwise inspect
`.superclarity/` and follow task state. Invocation style never weakens a gate.

Read only `.superclarity/` and the request, then announce:

```text
Task:  <slug>
Mode:  <Compact candidate | Compact | Full | recovery>
Phase: <preflight | clarify | survey | plan | run | verify | recover>
Gate:  <observable condition required next>
```

Do this before any other task-directed tool call. Reading, research, analysis,
and drafting count as execution when they advance the requested task.

## Recommend, then let the user select

Compact reduces review turns, never artifacts or prior approval. At entry,
select Full for a known disqualifier and recovery for invalid prior state.
Otherwise a new task may start as a Compact candidate while its necessarily
later clarification, provider, and plan facts are assembled. Candidate is not a
fourth persisted mode. It becomes Compact only when all of these are proven:

1. New low-risk task, fully reversible, one session, no conflicting state.
2. No money, sensitive data, external effect, submission, or consequential
   decision deliverable.
3. A bounded single-session plan that can run continuously after approval, with
   no mid-execution user gate, known replanning branch, or independent workstream.
   Step count is not a mode threshold.
4. Every provider already confirmed ready; no login, install, permission, quota,
   or capability-gap decision.
5. Every universal brief dimension is confirmed from the request or a recorded
   answer; no assumption or deferred gate can change the plan.

If an item is known false, recommend `full`. Otherwise recommend trying
`compact`. At brief closure explain both flows, in the user's own language —
the confirmed Chinese labels are `完整模式` and `尝试精简模式` — and ask the
user to select: `full` approves the displayed brief and surveys before a
separate plan review; `compact` assembles a no-probe bundle for one later
atomic review. This card is non-authorizing, so it may carry the
recommendation. `full` is always available. `compact` is a constrained
preference, not a waiver: if assembly needs an active probe or cannot prove an
item, record the reason, upgrade to `full`, and continue at its next gate
without asking for another mode choice. Never downgrade a selected `full` or a
running task.

It writes matching proposal `brief.md`, `capabilities.md`, and `plan.md`, shows
one bundle, and offers, in conservative-first order: approve plan only,
approve and execute, revise, or Full review. This bundle grants authority the
task did not already have, so it carries no recommendation, exactly like the
Full plan-approval card. Before approval use only visible provider evidence.
`Approve and execute` records brief approval, plan approval, and authorization
together, then runs without another confirmation. A request for Compact asks
to try this path; it never waives eligibility.

## Route by state

| State | Route |
| --- | --- |
| no valid mode decision or approved brief | `clarifying-intent` |
| approved brief, capabilities missing/stale | `surveying-capabilities` |
| capabilities resolved, plan missing/draft | `drafting-plans` |
| plan approved, execution unauthorized | ask for execution authorization |
| execution authorized, work outstanding | `running-plans` |
| every step validly terminal | `verifying-outcomes` |
| invalid order, stale revisions, prior unauthorized work | recovery protocol |

See [the state model](references/state-model.md) for lifecycle and chronology,
and [the entry protocol](references/entry-protocol.md) for gates and recovery.

## Gates that do not bend

- Preflight reads your own skill, tool, and subagent lists, and the names of
  the available domain profiles — free, already in context — because a question
  offering what this machine cannot deliver wastes an approval round. It writes
  nothing: that list is re-read every session and outranks any cache. Visibility
  is not readiness: auth, permission, and quota belong to survey, after the brief.
- Before the first state write, warn when `.superclarity/` is not ignored.
  Unignore only `profiles/` for deliberate sharing, never adjacent task state.
- Full survey needs an approved brief; Compact may only assemble a no-probe
  proposal bundle before its atomic review.
- No plan proposal without capabilities resolved against the same brief revision.
- No task action without an approved plan and explicit execution authorization.
- No completion claim without current evidence and a finalized report.
- Approval is prospective; it cannot authorize work already performed.

An incomplete artifact or filename opens nothing. Risk changes review depth,
not ordering; use [risk tiers](references/risk-tiers.md).

## Ask efficiently

Use a native card for two to four choices when available; otherwise ask in plain
text and stop. Never hardcode a host tool. Ask only when the answer changes
scope, provider, risk, dependencies, or success. `clarifying-intent` owns detail.

```text
.superclarity/
  environment.md
  profiles/
  <task>/ — profile snapshot, brief, capabilities, plan, ledger, report + manifest, data/
```

Files are evidence: revisions, ledger events, and timestamps order approvals,
and a later artifact without valid predecessors needs recovery, not backfilling.

## Resume

Read brief, capabilities, plan, and the ledger's latest events. Summarize what
was agreed, done, and next. Ask whether assumptions still hold. With several
unfinished tasks, or a request that may be new, include "start a new task"
rather than guessing. Reconcile a started-but-unfinished step against its
evidence before retrying, especially when an effect may be irreversible.

Load a matching domain profile during clarification. Precedence is project
`.superclarity/profiles/`, then user-global, then packaged; the first id that
matches wins and the others are not merged in. It supplies domain dimensions,
acceptance criteria, a step skeleton, and pitfalls — never generic workflow.
With no clear match, work generic rather than stretching an unrelated profile.
See [profile resolution](references/profile-resolution.md). Lesson candidates
reach a profile only through `distilling-lessons`, maintenance that never runs
as a step inside a task.
