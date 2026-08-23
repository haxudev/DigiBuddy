---
name: surveying-capabilities
description: Surveys what the local machine can actually do and binds each required capability to a ready provider before planning. Use after an approved brief for multi-step work, when tooling is unknown (有什么工具 / 本机能力 / 装了哪些技能 / 能不能做), or when a provider becomes unavailable and replanning is required. Introspects visible skills, tools and subagents first, then probes only task-critical gaps. Produces .superclarity/<task>/capabilities.md and caches probed readiness in environment.md. Do NOT use before the router selects survey, for exhaustive machine inventory, or as permission to continue execution after a provider failure.
license: MIT
metadata:
  pack: superclarity
  phase: survey
---

# Plan against the machine you have

A named binary is not necessarily authenticated, and a skill description is
not proof of readiness. Resolve each need before planning, when changing course
is still cheap.

Answer in the user's language.

## Preconditions

Full mode requires an approved current brief. While assembling a Compact bundle,
a complete draft brief may be used only to resolve providers already visible in
context; any active probe or user action upgrades to Full. Survey is not task
execution: do not collect task data or produce the deliverable.

Preflight already established what is visible, in this session's own context.
This phase adds readiness and binding, not discovery. Re-listing the machine is
repeated work, and visibility was never the question that blocks planning.

## Procedure

1. **Start from preflight.** Use the visible tool, skill, and subagent lists it
   read, and `environment.md` if a previous survey left a readiness cache. Do
   not enumerate the machine again.
2. **Derive needs from the brief.** Use the closed — fourteen capability taxonomy
   in [capability taxonomy](references/capability-taxonomy.md).
3. **Probe only unknown readiness.** Use the smallest task-scoped check from
   [probe recipes](references/probe-recipes.md). Absence from context is not
   proof of absence from the machine.
4. **Bind provider and fallback.** Load a matching specialist skill before
   relying on its behavior; its description alone is not enough.
5. **Resolve every gap.** A gap is open until the user agrees to manual supply,
   a confirmed substitute, dropping scope, or an installation is completed and
   re-probed.
6. **Write artifacts.** Create [`capabilities.md`](templates/capabilities.md)
   against the brief revision, then append its observation to `ledger.jsonl` —
   one JSON object per line, `seq` counting up from 1, `at`
   never going backwards and at or after the file it records:
   `{"seq":<next>,"at":"<ISO>","kind":"artifact","artifact":"capabilities","revision":1,"digest":"sha256:<of capabilities.md>"}`.
   The event recording the resolved bytes carries `surveyed_at` as its own
   `at`, and nothing is appended for that revision afterwards: a digest written
   before those bytes existed attests nothing, and one written after covers a
   change the plan was never checked against. Every re-survey appends its own
   event with the next revision and the digest of the bytes it observed, so a
   resurvey after a recovery resolution is ordered by that event rather than by
   when the file first appeared. Resolved capabilities are frozen: changing them
   means a new revision, which invalidates plan and report, and editing the file
   in place puts the task into recovery. A task on
   `task-ledger/1` omits `revision` and `digest` and records only the first
   appearance. Write timestamped `environment.md` only when a probe learned
   something worth reusing; a survey that probed nothing has nothing to cache.

## Readiness vocabulary

- `confirmed`: visible or probed now, including required auth/permission/quota.
- `assumed`: declared by config but not verified; not plannable.
- `GAP`: no ready provider; not resolved and does not open the planning gate.
- `resolved-manual`, `resolved-substitute`, `resolved-drop`: user-approved gap
  handling with its consequence recorded.

An installed cloud CLI that is logged out is a gap for a step that calls it:
presence is not readiness. Never invent tooling or promote `assumed` to
`confirmed` without evidence.

## Gap decisions

Present only findings that change the plan:

1. User supplies a redacted export or performs authentication themselves.
2. Use a weaker confirmed substitute, naming lost accuracy or coverage.
3. Drop the affected scope, naming what the result can no longer establish.
4. Install a provider with approval, then re-probe before marking confirmed.

Never ask for credentials. Record the decision under the brief's capability
decisions, not assumptions. If it changes outcome, scope, constraints, risk, or
success criteria, increment and reapprove the brief; the old capability survey
and every downstream artifact become stale.

## Compact boundary

A Compact candidate is finalized as Compact only when introspection confirms
every provider without an active probe or user action and there are no gaps.
Discovering login, install, permission, quota, or gap decisions upgrades the
task to Full before planning. Missing readiness at candidate entry is not by
itself a reason to pre-classify Full; needing an active check to resolve it is.

## Re-survey during execution

A failed provider does not authorize task work inside this phase. Stop the
current step, survey readiness, and revise capabilities. If bindings or gap
handling change, invalidate and reapprove the plan before resuming.

## Cost discipline

T0 introspection belongs to preflight, is free, and is never written down: the
session's own list is re-read every time and outranks any file. This phase
spends T1 on one or two targeted checks, and T2 deep checks only before an
expensive commitment or after a diagnosed failure. Write what a probe taught you
to `environment.md` with its timestamp, OS, harness, and relevant account or
tenant, so the next task in the same context need not pay for it again.
