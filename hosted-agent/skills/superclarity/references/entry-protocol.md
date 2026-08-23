# Entry protocol

## State before classification

Before any task-directed discovery, inspect only `.superclarity/` and the
current request. Your own skill, tool, and subagent lists are exempt: they are
already in context, cost nothing to read, and disclose nothing about the task.
Existing state outranks a new mode classification. If the artifacts form an
invalid prefix or task work predates authorization, enter `recovery-required`;
do not fill in the missing history.

Then make routing visible. `Compact candidate` means the Compact hypothesis is
still being tested before approval; it is not a fourth persisted mode:

```text
Task:  <slug>
Mode:  <Compact candidate | Compact | Full | recovery>
Phase: <preflight | clarify | survey | plan | run | verify | recover>
Gate:  <observable condition required before the next phase>
```

Emit these lines before any other task-directed tool call. Reading files,
searching, analysis, research, and drafting a deliverable are task execution
when they advance the requested work. Before brief approval, only inspect
context or sample files narrowly enough to make the brief concrete.

## Preflight

A question offering what this machine cannot deliver costs a whole approval
round: the user chooses, the brief is approved, and survey then finds no
provider — so the brief must be revised and reapproved. Preflight is the
cheapest available guard, because everything it reads is already in context.

Read, at the start of every session: installed skills and their descriptions,
available tools including MCP-provided ones, subagents, whichever selection card
the host exposes, and project rules already loaded. Keep them in this session's
working context. They are per-session and authoritative over anything a cache
remembers, so preflight writes no file: a copy that is re-read every session and
never trusted over the live list is a write nobody reads.

Also read which domain profiles are available: the file names in
`.superclarity/profiles/`, in `~/.superclarity/profiles/`, and in the pack's own
`profiles/` directory, each with where it came from. List the names; do not open
them. Clarification cannot match a request against a set it never enumerated,
and a profile found after the brief is approved changes which questions should
have been asked. Listing names is not reading configuration — the matching
profile is opened during clarification, by the phase that needs its content.

Preflight establishes visibility, never readiness. Whether a provider is
authenticated, permitted, and within quota is survey's question, and it cannot
be answered before the brief names which providers the task needs. So preflight
runs no command, reads no configuration file, logs into nothing, installs
nothing, and touches no task data.

Visibility is session-scoped, not task-scoped. It carries no task content, and
establishing it before an approved brief is never out-of-order work. The one
file in this area, `environment.md`, belongs to survey: it caches readiness that
cost a probe, so the next task in the same context need not probe again.

## Choose the mode

Invocation style never weakens a gate. Explicit and automatic invocation use
the same rules. An explicit invocation routes even a small request through this
protocol; a small eligible request can still use Compact.

Activation happens before this protocol loads. Once loaded, the router has no
internal exit path: it must choose Compact, Full, or recovery and hold the same
execution gates in every case.

At entry, choose Full immediately for any known Full signal below, and recovery
for invalid or unauthorized prior state. Otherwise a new task may start as a
Compact candidate even though clarification, provider bindings, and its
prospective plan do not exist yet. Treating those necessarily-later facts as
unknown reasons for Full makes Compact unreachable in normal use.

The candidate becomes Compact only when the assembled bundle proves every
condition below:

1. New task with no conflicting unfinished state or recovery incident.
2. Low risk, fully reversible, no money, sensitive data, external effect, or
   output intended for submission or a consequential decision. As an additional
   guard, no step may use `communicate` or `cloud-ops`; that list does not replace
   evaluating every capability and operation for external effects.
3. The plan fits one session and can run continuously after authorization, with
   no mid-execution user gate, known replanning branch, or independent workstream.
   Split steps honestly at provider, dependency, verification, and risk
   boundaries; step count is not an eligibility threshold.
4. Every provider is already confirmed ready; no login, installation, quota,
   permission, or capability-gap decision is needed.
5. All five universal brief dimensions are confirmed from the current request
   or a recorded answer. None may be assumed or deferred, and no profile
   assumption or deferred gate may change the plan.

If a known condition is false, use Full. If candidate assembly needs an active
probe or user readiness action, or the complete bundle cannot prove a condition,
upgrade to Full before acting. Modes never downgrade mid-task; candidate-to-Full
is an upgrade, not a downgrade from an already selected mode.

A user may request Full and force the more deliberate review. A request for
Compact means "try the Compact candidate path"; it cannot supply missing
eligibility evidence or waive a gate.

At brief closure, recommend a mode from the evidence and ask the user to select
the review flow. This is the one mode decision, not an invitation to waive
eligibility. This card is non-authorizing — approving it grants nothing by
itself — so it may carry the recommendation. Show both, in the user's own
language; the confirmed Chinese labels are `完整模式` and `尝试精简模式`,
persisted as `full` and `compact`:

1. `full` approves the displayed brief now, resolves capabilities, presents the
   plan separately, then runs only after plan authorization.
2. `compact` assembles a no-probe brief/capability/plan bundle, then presents
   one atomic approval with plan-only and execute-now choices, plan-only first.

Put the supported recommendation first and explain why. `full` is always
selectable. `compact` is selectable as an attempt when no known disqualifier
exists; if later assembly proves one, record the reason, upgrade to `full`,
explain the change, and continue at the next `full` gate without asking for
another mode choice. A known disqualifier may be shown as the reason `compact`
is unavailable, not as a choice the user can force.

## Gates

| Phase | May not start until | Ends when | Forbidden before that |
| --- | --- | --- | --- |
| preflight | request exists | this session's visibility and profile names are established | probing, setup, or task execution |
| clarify | visibility is established | `brief.md` records the mode selection; Full is approved, or Compact assembly is selected | task execution or deliverable work |
| survey | Full: `brief.md` approved; Compact: complete draft brief | `capabilities.md` is resolved against that revision | Full planning, active setup, or task execution |
| plan | `capabilities.md` resolved; Full also requires approved brief | `plan.md` is complete and approved | task execution |
| run | `plan.md` approved and execution authorized | every step is validly terminal | unplanned or unauthorized actions |
| verify | `plan.md` has every step validly terminal | `report.md` is finalized and the bundle matches `delivery-manifest.json` | claiming completion or delivery |
| recover | invalid ordering or unauthorized work observed | the ledger records a resolution and a matching prospective plan exists, or the brief is cancelled | execution, backfilling, or completion claims |

An artifact opens a gate only when structurally complete, current, and carrying
the required status and timestamp. Presence alone is insufficient.

## Compact approval

Compact prepares matching `brief.md`, `capabilities.md`, and `plan.md` proposals
before execution, then presents one short bundle. The plan has as many honestly
separated steps as the work needs; Compact does not impose a fixed count.
Before approval it may use
already-visible provider evidence, but cannot actively probe, install, log in,
or perform task work:

```text
Outcome and scope: ...
Confirmed sources, profile assumptions, and success: ...
Provider readiness: ...
Plan and verification: 1. ... 2. ...
If an assumption or deferred gate is wrong: ...
```

Offer, in this conservative-first order, `Approve brief and plan, do not
execute`, `Approve brief and plan, then execute`, `Revise`, and `Use Full
review`. This bundle card grants authority the task did not already have, so
it carries no recommendation, exactly like the Full plan-approval card. The
first leaves `ready-to-run`. The second records all approvals plus execution
authorization before action; both approved Compact artifacts record the same
approval event ID and timestamp, and it routes directly to execution without
another plan or authorization question. Compact means one review, not no
review.

An empty discovery log is valid only when every universal dimension cites the
current request as its source. The combined review and execution authorization
still happen afterward; asking nothing never means zero user review.

## Full selection and approval

Selecting `full` from the brief closure card approves that displayed brief and
permits survey; it does not approve a future plan or authorize execution. This
plan-review card grants authority the task did not already have, so it stays
conservative-first with no recommendation. In order: `批准计划`
(`approve-plan-only`), `批准并自动完成` (`approve-and-auto-execute`),
`修订计划` (`revise`), `取消` (`cancel`).

`approve-and-auto-execute` records plan approval and execution authorization
prospectively, then runs and verifies without routine confirmation. It pauses
only at a declared medium/high-risk action gate, a scope/provider/dependency/
risk/success change, an access or setup gap, an uncertain non-retry-safe
effect, or a failure whose viable paths require a user trade-off.
`approve-plan-only` leaves the task ready to run, so a later start remains
explicit. Action gates inside either path still protect costly or irreversible
effects.

## Recovery

If work occurred before valid authorization:

1. Stop immediately and state what happened, its known cost/effects, and which
   gate was missing.
2. Append a `recovery-incident` event to the ledger; do not create a normal
   history around the completed output.
3. Explain that approval now cannot authorize prior actions.
4. Offer discard/restart, revalidate as untrusted input, or stop.
5. After the decision, create prospective artifacts for remaining or
   revalidation work only, reissuing the brief, capabilities, and plan in
   `mode: recovery`. Every plan step starts with no recorded status.
6. Record each reissue as its own ledger `artifact` revision event dated after
   the resolution. A task that already had a plan cannot leave recovery
   otherwise: the reader orders the artifact by the revision now in force, and
   an observation from before the incident cannot order a file written after it.

If the user chooses stop, append that resolution and mark the brief cancelled;
do not keep presenting recovery as unfinished work.

Never mark old work `completed` in a newly written plan. Never infer historical
providers after the fact. Verification fails closed into recovery when a
predecessor or chronology is invalid.

## No file writing

Use the same named artifacts as structured conversation blocks and disclose
that they are volatile. Their statuses and timestamps must still satisfy the
same gates. Do not ask the user to save them or imply they survive the session.
