---
name: drafting-plans
description: Turns an approved brief and resolved capability map into a prospective, user-approved execution contract. Use for multi-step or long-running work after clarification and provider readiness are complete (写个计划 / 制定计划 / 拆解一下 / 排一下步骤 / 分几步做). Binds every step to a confirmed provider, dependency, fallback, risk, and verification criterion, then records execution authorization separately. Produces .superclarity/<task>/plan.md. Do NOT use without resolved capabilities and either an approved brief or router-selected Compact bundle assembly, for standalone invocation, or to reconstruct work already performed.
license: MIT
metadata:
  pack: superclarity
  phase: plan
---

# A plan is a prospective contract

A retrospective list of actions is a log, not a plan. This phase describes what
will happen before resources are spent, so the user can change it cheaply.

Answer in the user's language.

## Preconditions

Full mode requires an approved brief. Compact bundle assembly may use a complete
draft brief. Both require `capabilities.md` with status `resolved` and the same
brief revision. Every active step needs a confirmed provider or agreed
manual/substitute handling; `GAP`, `assumed`, and `TBD` are not providers.

If task-work evidence already exists without prior authorization, stop and
enter recovery. Never write a plan around completed work or initialize an old
action as `completed`.

## Step contract

Use [`plan.md`](templates/plan.md). Each step has:

- a stable `id`, unique in the plan and reused across revisions only for the
  same work;
- one capability and a ready provider;
- a confirmed fallback;
- a named artifact or observable verification;
- explicit dependencies and required outputs;
- risk and whether retrying is safe.

A step carries no status. Status is derived from the ledger's step events, so an
approved plan is never rewritten to record what already happened — and a plan
that cannot be rewritten cannot be quietly rewritten to fit the work.

Append to `ledger.jsonl`, one JSON object per line, `seq` counting up from 1 and
`at` never going backwards: an `artifact` event whenever the file changes, and
the authorization once the user gives it. The plan changes three times under one
revision — drafted, approved, authorized — so it is observed three times, each
carrying that revision number and the digest of the bytes as they then stand,
the latest of which must match the file. Approval and authorization each freeze
a set, so those events carry `approved_at` and `authorized_at` as their own
`at`: written earlier a digest attests bytes that did not exist yet, written
later an edit nobody approved.

```json
{"seq":<next>,"at":"<ISO>","kind":"artifact","artifact":"plan","revision":<revision>,"digest":"sha256:<of plan.md>"}
{"seq":<next>,"at":"<ISO>","kind":"plan-authorized","planRevision":<revision>,"planDigest":"sha256:<the same digest>","steps":[{"id":"<step id>","contract":"sha256:<of the ten contract fields>"}]}
```

Write `authorized_at` into the plan, append the `artifact` event for those bytes
at that instant, then the authorization naming that digest and that instant: it
binds what exists where it stands, never what the file becomes afterwards.
Nothing edits an authorized plan — a new revision is the only way to change one
— so a later event for that revision is refused and a file that moved on without
one fails the digest check; the task is in recovery either way.

Every revision gets its own authorization, because a step event names the
revision it belongs to and is judged against that revision's authorization. A
contract digest is the SHA-256 of `capability`, `provider`, `fallback`,
`verify`, `depends`, `risk`, `operations`, `origin`, `revalidates` and
`retry-safe`, one `<name>:<value>` per line in that order, with `depends` naming
the step id it points at, not its position. A task opened on `task-ledger/1`
keeps that grammar instead: no step ids, no digests, one observation per file.

A step normally spans one or two operations. Combine cheap reversible work that
uses one capability; split at provider, dependency, verification, or risk
boundaries. A five-step plan is usually clearer than fifteen tiny updates.

## Plan from the brief

The problem frame, shortlist, weights, scope, and success criteria must already
be settled. Execution gates may resolve operational choices, but not decisions
that determine which plan should have been approved. Do not write a step whose
verification edits `brief.md` or `capabilities.md`; revise and reapprove those
artifacts before planning instead.

When the brief names a profile, its step skeleton and its known pitfalls are
read from task-local `profile.md`, never the mutable live profile. They are this
phase's raw material, and the `Profile coverage` table is where every stable id is
accounted for: a skeleton item becomes a step or a stated deletion, a pitfall
becomes a `verify` line or a risk level on the step where it bites, or a reason
it does not apply. Merge or delete freely — the skeleton is a starting shape,
and a step for something the brief already settled is waste. What is not
allowed is silence: an unlisted pitfall is one nobody decided about.

Route domain work through a confirmed specialist when one exists. Load its full
instructions before relying on it. A description proves relevance, not behavior.

## Risk gates

Execution authorization is the only additional action approval a wholly
low-risk plan needs. Medium/high plans add `ask-user` steps immediately before
meaningful cost, external output, or irreversible effects. A useful gate states
the action, cost/duration, irreversible effect, alternatives, and an
evidence-supported recommendation when one is justified.

## Compact planning

Compact plans use as many steps as honest provider, dependency, verification, and risk boundaries require; never merge them or select Full from count alone.
The plan must be bounded, single-session, low-risk, reversible, provider-ready, and free of mid-execution gates or known replanning branches. This bundle card
grants authority the task did not already have, so it stays conservative-first with no recommendation, exactly like the Full plan-approval card. Present the
brief, readiness, steps, and verification in one review, in order:

1. Approve brief and plan, do not execute.
2. Approve brief and plan, then execute.
3. Revise.
4. Use Full review.

Record approvals and authorization before action. Option 2 is atomic and routes directly to execution without another question. Upgrade a non-Compact shape or
capability gap to Full before review.

## Full planning
This card grants authority the task did not already have, so it stays conservative-first with no recommendation. In order: `批准计划` (`approve-plan-only`), `批准并自动完成` (`approve-and-auto-execute`), `修订计划` (`revise`), `取消` (`cancel`).
`approve-plan-only` leaves the plan ready to run; `approve-and-auto-execute` freezes and authorizes it, then runs and verifies without routine confirmation. An ambiguous "sure" authorizes neither. Auto-execution still pauses at declared risk gates, contract changes, access/setup gaps, uncertain non-retry-safe effects, and failures requiring a user trade-off.
## Revisions

Reality can invalidate a plan; it cannot silently rewrite one. Stop, explain the
finding, and offer revisions and consequences. Then, in this order and no other:
stop executing; obtain agreement; write the new revision and append its
`artifact` event with the new number and digest; get approval and append another
at `approved_at`; record the authorization and append one more at
`authorized_at`, then the `plan-authorized` event at that instant binding that
digest and every step's contract digest; resume with the steps that are not yet
terminal. Also append the change as a `deviation` note. Changing the brief or
capabilities first invalidates this plan until reapproved.

A step whose id and ten contract fields are unchanged keeps the terminal result
recorded under any earlier revision — revisions are read in order, so work built
on an earlier revision's result keeps both — which is what stops a revision from
costing a re-run of finished work and so from being written to fit the work
instead. A step whose id is new, whose contract changed, or whose earlier
attempt was left running, failed, or blocked starts again as pending: an attempt
is not a result, and a result for one contract says nothing about another.

Never use a revision to manufacture prior authorization. Recovery plans include
only future or explicit revalidation steps, and nothing carries across a
recovery resolution however unchanged it looks — the incident found that the
earlier work was never authorized.
