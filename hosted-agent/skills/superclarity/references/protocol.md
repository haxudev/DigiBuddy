# Protocol: gates, state, and `next`

This is the executable contract in prose. `skills/superclarity/scripts/*.mjs`
implements every rule stated here; if the two ever disagree, the code is a
bug against this document, not the other way around.

## Derived state

The CLI derives one `state` from the three files plus the ledger, using the
first matching row:

| State | Meaning | Typical `next` |
| --- | --- | --- |
| `unsupported` | legacy artifact, unreadable schema, or a corrupted ledger batch that isn't a repairable tail | `start-new-task`, or `reconcile-external-state` if the readable prefix shows an unmatched action |
| `blocked` (ledger) | only the final ledger batch is truncated | `repair-ledger` |
| `recovery-required` | an opened recovery has no resolution yet | `resolve-recovery` |
| `cancelled` | the task was cancelled, or recovery resolved with `stop` | `none` |
| `needs-reapproval` | current bytes no longer match an existing approval, or a Compact task must upgrade after recovery | `check-terms` / `check-execution` / `upgrade-to-full` / `increment-revision` |
| `awaiting-approval` | a prepared gate matches current bytes | `request-<gate>-approval` right after `check`; `reprepare-<gate>` on a later `status` |
| `accepted` | the recorded acceptance matches current bytes, revision, and re-hashed evidence; the response carries the user deliverables | `none` |
| `drafting` | contract/capabilities/plan incomplete, or awaiting the next approval step | `fix-contract` / `resolve-capability` / `write-plan` / `check-terms` / `check-execution` / `check-compact` |
| `executing` / `blocked` (step) | execution authorized; the plan's scheduler picks the current step | see below |
| `verifying` | every step terminal, acceptance not yet validly recorded | `write-acceptance` / `revalidate-evidence` / `record-acceptance` |

Never treat a mere file's existence as an open gate — the CLI checks
structure, digests, and ordering every time.

For `accepted`, `next: none` means no further ledger transition, not "send no
result." The response's `deliverables[]` and `display.delivery` are the
handoff contract: open every listed file, present the requested substance in
the final reply (inline when the user asked for content, otherwise as an
accessible attachment/path), and name any gap. Internal `.superclarity/`
state, evidence, and working notes are never substitutes for those files.

## Step scheduler

Walk `contract.md`'s steps in document order; the first non-terminal one
governs `next`:

- **running** → `reconcile-step` (an interrupted attempt; see recovery.md).
- **failed/blocked** with an unused declared fallback → `blocked` /
  `assess-fallback` (you judge the natural-language trigger; if it applies,
  invoke the fallback — through `check --gate action --binding fallback` when
  the effect is gated, otherwise `step fallback` directly).
- **failed/blocked**, no eligible fallback, `retry-safe: yes`, and at most one
  prior primary attempt → one retry (`check-action` if gated, else
  `start-step`).
- otherwise → `blocked` / `ask-user`.
- **pending** with dependencies satisfied → `check-action` (gated) or
  `start-step`.

Two same-cause primary failures without a working fallback stop for a
decision; do not keep retrying automatically.

## Gates

| Gate | Precondition | Binds |
| --- | --- | --- |
| `compact` | mode compact, plan complete, every capability `ready`, every effect `none`/`read-external`, every step reversible, no execution/recovery history yet | `terms` |
| `terms` | mode full | `terms` |
| `execution` | terms approved (current digest); plan complete; every capability the plan uses is executable (`ready` or a `resolved-*`) | `terms` + `plan` |
| `action` | execution is authorized for the current contract, the step is the scheduled one and requires a gate, and no resolved `occurred` recovery still owes it a revalidation; `--action-json` supplies the exact runtime target/content/cost/impact/alternatives for the chosen `effect` | the runtime action payload, not just the plan text |

Every `check` appends a fresh `contract-recorded` + `gate-prepared` pair and
returns a one-time token; `approve --token ... --decision ...` re-validates
current bytes, then appends the approval events atomically. Any later event —
including a `repair` — invalidates a prepared gate; re-run `check`.

Full's plan review is conservative-first: `approve-plan-only`,
`approve-and-execute`, revise (edit the contract yourself), `cancel`. Compact
adds `use-full` alongside those. `approve-and-execute` binds authority for
ordinary steps only — gated steps still need their own `action` approval
every attempt.

An action gate is *inside* an authorized plan, never a substitute for one.
`check --gate action` refuses unless execution is already authorized for the
current contract and the step is the scheduled one, so a consequential step
can never be approved on its own in a contract nobody approved.

## Risk

Risk selects the review shape; it never decides whether the gates apply.
Compact exists for work where one combined card genuinely costs the reviewer
less attention than three, and its preconditions are objective rather than a
judgement call: every effect `none`/`read-external`, every capability
`ready`, every step reversible, single-session, private, no sensitive data,
not consequential, and able to run continuously once authorized. Fail any one
and it is Full — a requester may ask for Full, but cannot waive Compact's
conditions.

The five gated effects (`send`, `publish`, `payment`, `infra-change`,
`destructive`) are treated as high-risk regardless of how small the instance
looks, because the reviewer cannot un-send a message or un-spend money after
the fact. Step count is not a risk signal: a single-step task that pays an
invoice outranks a twenty-step task that reads local files.

## Revision

A revision may change freely while no step has started. Once any step has
started, semantic drift (terms or plan content, not just Markdown layout)
requires incrementing the revision by exactly one; a step's prior terminal
result carries forward only when its contract (action + capability binding)
is byte-for-byte unchanged. A Compact task that must revise after execution
began switches `mode` to `full` and bumps the revision — Compact is not used
mid-execution.

## Execution

Record `step-started` immediately before the real action, and `step-finished`
only after opening the evidence the `verify` line names — never on a tool's
mere return value. `acceptance.md` may claim `complete` only when every
success criterion is `yes`, no step was skipped, and there are no open gaps;
anything else is `partial`. `accept` re-hashes every completed step's file
evidence; drift there — even after delivery — reopens the record for
`step revalidate --basis stale-evidence` and a new `accept`.

## Cancellation

`recover cancel --reason ...` ends an ordinary task between steps (never
while a step is running, and never while a recovery is open — resolve it
first). It is distinct from declining an approval card, which uses
`approve --decision cancel` against the card's own token.
