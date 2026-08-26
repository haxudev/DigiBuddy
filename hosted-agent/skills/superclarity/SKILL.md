---
name: superclarity
description: Clarifies intent, surveys what this machine can actually do, plans against real capabilities, executes under explicit authorization, and verifies with evidence before claiming done. Use for planning requests (规划 / 计划 / 做个方案 / 拆解一下 / 怎么做), resumed work (继续 / 接着做 / 上次做到哪了), and any task involving money, sensitive data, irreversible or external actions, submission or publication, third-party deliverables, or important-decision outputs, regardless of step count. If any of that is true or unknown, load this skill first. Low-risk, reversible, single-session work with ready providers uses one combined Compact review; everything else uses Full's two-gate review, with an immediate action gate before every payment, publish, send, infrastructure, or destructive step. Do NOT use for plain factual questions, coding-specific methodology, or reversible local requests that are neither multi-step nor consequential.
license: MIT
compatibility: Persistent mode requires Node.js 20 or newer to run scripts/superclarity.mjs. Without it, use the session-only protocol in references/cli.md instead of skipping gates.
metadata:
  pack: superclarity
  phase: all
---

# Route the work, preserve the order

A long task fails at its seams: work starts before intent is agreed, a plan
assumes a tool this machine does not have, or a claim of "done" outruns the
evidence for it. This skill closes those seams with one task state built from
three files, not a promise to remember.

## Enter here

Read only `.superclarity/<task>/` and the current request, then run:

```text
node <skill-root>/scripts/superclarity.mjs status --workspace <path> --task <slug>
```

`<skill-root>` is the directory containing this file; resolve it via the
host's own skill path, never a hard-coded install location. Its JSON reply
carries exactly one `state` and one `next` — follow `next`, do not re-derive
state by reading the files yourself.

For a task that does not exist yet, create it with `init`, never by writing
the artifacts by hand:

```text
node <skill-root>/scripts/superclarity.mjs init --workspace <path> --task <slug> --mode compact|full
```

Hand-written artifacts are rejected as `unsupported`, because only `init` can
lay down the three files and the opening ledger event together. Fill in the
templates it creates; do not invent the ledger.

Run the CLI with no arguments (or `--help`) for the full command surface. It
is self-describing on purpose: never read `scripts/*.mjs` to work out how to
drive it, and never edit those scripts to make a task pass. If a reply is
unclear, the answer is in [the CLI reference](references/cli.md) or
[the artifact format](references/artifact-format.md), never in the source.
Reading, researching, analyzing, and drafting count as task execution once
they advance the request; do them only after the gates below allow it.

## The three files

```text
.superclarity/<task-slug>/
  contract.md     objective, scope, constraints, success criteria, capability
                   bindings, and the execution plan — one file, one document
  ledger.jsonl     append-only events: gates, approvals, step attempts,
                   evidence, recovery, acceptance
  acceptance.md    the acceptance record: outcome summary, where each
                   deliverable lives, per-criterion evidence, coverage gaps
  data/            optional working material; never read for state
```

`acceptance.md` is not the deliverable. Deliverables are ordinary files in the
workspace; the record's `Deliverables` table names each one's `Location`.
Writing the deliverable into it leaves nothing to hand over.

Acceptance is not the final user handoff. When the CLI reports `accepted`,
`next: none` means only that no ledger transition remains. Open every file in
the response's `deliverables[]`, then finish the same turn by presenting what
the user asked for: include the substantive result inline when they asked for
content, and always provide each accessible path or attachment. Do not hand
over `contract.md`, `ledger.jsonl`, `acceptance.md`, evidence, or working notes
as substitutes. Use `display.delivery` for the verified summary and gaps.

No other file carries state. A task directory holding any pre-vNext artifact
(`brief.md`, `plan.md`, `report.md`, ...) is `unsupported`: start a new task
rather than trying to migrate or reuse it.

## Clarify only what changes the plan

Before the first review, read this session's own visible tools/skills/
subagents — never probe, install, or touch task data yet — then ask only
about decisions that would change scope, a capability, an `effect`,
dependencies, or success criteria. Zero questions is a normal outcome for a
fully specified request; there is no minimum or maximum count. Everything
else you decided without asking goes into the contract's `Assumptions`
table with its basis and consequence. See
[clarifying](references/clarifying.md) for the stop rule, question design,
and portable choice-card handling — never hard-code a host tool's name.

## Resolve capabilities against this machine, not a wishlist

Name whatever the task actually needs as a free-form capability row; there is
no fixed vocabulary. `ready` means confirmed in this session, including
login/permission/quota — visible is not the same as ready. A gap closes only
by the user installing and letting you recheck, supplying material manually,
accepting a named weaker substitute, or dropping that scope; record which,
and its effect on the result. See [capabilities](references/capabilities.md).

## Two review shapes, one set of gates

**Compact** (`node ... check --gate compact ...`): every step's `effect` is
`none` or `read-external`, every capability is `ready`, and the task is
single-session, private, reversible, and not consequential. One card offers,
conservative option first: approve only, approve and execute, revise, or use
Full. **Full**: `check --gate terms` then `check --gate execution`, each its
own approval — plan-only leaves it ready to run, approve-and-execute runs
straight through. Before either card, the CLI validates structure and issues
a one-time approval token; hold it until the user answers, then pass it to
`approve` — never show it to the user.

The card itself comes from `check`: show `display.summary` as the review,
translated into the user's language, and do not compose your own from the
contract. It is a requirements confirmation — it asks whether the job was
understood, so its `DECIDED FOR YOU` section is the part most likely to be
overturned and must never be dropped or summarized away. `display.review`
carries the same content structured, if you need to re-lay it out. See
[the protocol](references/protocol.md) for the full state table and every
`next` value, and [risk tiers reasoning](references/protocol.md#risk).

## Action gates never get folded into a plan review

Any step whose `effect` is `send`, `publish`, `payment`, `infra-change`, or
`destructive` needs its own `check --gate action` — with the exact runtime
target, content, cost, irreversible impact, and alternatives — immediately
before that one call, every attempt, fallback included. Approving a plan
never authorizes the action inside it.

## Execute, verify, recover

Start only the step `next` names. Record completion only after opening the
named evidence — a tool returning success is not evidence. A step that fails
twice the same way stops for a decision rather than looping; a step may be
skipped only on an explicit user decision. `acceptance.md` claims nothing
that lacks current, re-hashed evidence for each success criterion, and "not
observed" is a coverage gap, never a claim that something does not exist.
Recovery is for two things only: work found predating its authorization, or
an external effect whose outcome is unknown — not for an unapproved draft,
which you simply fix. See
[running/verifying](references/protocol.md#execution) and
[recovery](references/recovery.md).

## Resume

`status` on an existing task reports where it stands; if several tasks look
open, or the request might be new, ask, and always offer "start a new task."
For a step whose last event is an unmatched start, reconcile its named
evidence before deciding to retry — repeating an uncertain irreversible call
can perform it twice.
