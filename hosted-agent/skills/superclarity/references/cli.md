# CLI reference

```text
node <skill-root>/scripts/superclarity.mjs <command> [subcommand] --workspace <path> --task <slug> [options...]
```

Every mutating command validates before writing, appends one atomic batch,
then re-validates and reports the new state. Every response is one JSON
object on stdout with a stable shape:

```json
{
  "schema": "superclarity-diagnostic/1",
  "ok": true,
  "command": "check",
  "task": "vendor-review",
  "state": "awaiting-approval",
  "next": "request-compact-approval",
  "revision": 1,
  "digests": { "...": "..." },
  "ledger": { "batches": 2, "seq": 3, "businessSeq": 3 },
  "approvals": { "termsApproved": false, "planApproved": false, "executionAuthorized": false },
  "steps": [ ],
  "gate": { "type": "compact", "preparedSeq": 3, "stepId": null },
  "options": [ { "id": "approve-and-execute", "label": "...", "actionKind": "cli", "command": "approve", "arguments": ["--decision", "approve-and-execute"] } ],
  "token": "sct1_...",
  "display": { "summary": "...", "action": null },
  "deliverables": [ { "id": "D1", "location": "docs/review.md", "purpose": "decision-ready review" } ],
  "diagnostics": [ ]
}
```

Follow `next` and `options` rather than re-deriving state from the files
yourself. `token` appears only on a successful `check`; hold it in this
conversation until the user answers, then pass it straight to `approve` —
never show it to the user or write it down elsewhere.

An `accepted` response populates `deliverables[]` and `display.delivery`. There is
no further CLI transition (`next` remains `none`), but the conversation is not
finished until the agent opens those files and presents the requested result
to the user. Internal `.superclarity/` files are records, never deliverables.

On a successful `check`, `display.summary` is the finished approval card and
`display.review` is the same content as structured fields. Requirement and
plan cards use `objective`, `scope`, `constraints`, `criteria`,
`decidedForYou`, `capabilities`, `plan`, and `grants`; an action card instead
contains the exact runtime `target`, `summary`, `cost`, `irreversibleImpact`,
`alternatives`, `details`, `binding`, `reason`, and `consequence`. Relay the
card in the user's language instead of assembling one
from `contract.md`: a hand-built card varies every run and tends to omit
`decidedForYou`, which is exactly the section a reviewer needs in order to
correct a wrong assumption before any work starts.

## Commands

| Command | Purpose |
| --- | --- |
| `init --mode compact\|full` | create a new task's three files |
| `status` | read-only: current state, next, diagnostics |
| `check --gate compact\|terms\|execution\|action ...` | validate and prepare one gate; returns a token |
| `approve --token ... --decision ...` | consume a prepared gate |
| `step start --step S1 --readiness-confirmed C1` | begin the current step (ungated effects only) |
| `step fallback --step S1 --reason ... --readiness-confirmed C1` | begin an ungated fallback attempt |
| `step finish --step S1 --outcome completed\|failed\|blocked --detail ... [--evidence-file ...] [--evidence-external ...]` | close the current attempt |
| `step skip --step S1 --decision ... --impact ...` | record an explicit user decision not to run a pending/failed/blocked step |
| `step revalidate --step S1 --basis stale-evidence\|recovery-occurred --evidence-file ...` | refresh evidence without re-running the action |
| `accept --verdict complete\|partial` | bind the current acceptance bytes as accepted |
| `recover open --code unauthorized-work\|uncertain-effect --summary ... --output ref=effect` | open a recovery |
| `recover resolve --decision ... --reconciliation ... --consequences ...` | close a recovery |
| `recover cancel --reason ...` | cancel an ordinary task between steps |
| `repair [--lock]` | fix a truncated final ledger batch, or clear a lock claim that is provably dead — it says which, and refuses a claim it cannot prove is abandoned |

## Gate-specific options

- `check --gate compact` and a Compact `execution` gate additionally require
  `--single-session --private --no-sensitive-data --not-consequential
  --continuous` plus `--readiness-confirmed C<n>` for every capability the
  plan uses.
- `check --gate execution` (any mode) requires `--readiness-confirmed` for
  every capability the plan uses.
- `check --gate action --step S1 --binding primary|fallback --action-json
  <path> --readiness-confirmed C<n> [--reason ...]` requires the exact runtime
  payload and exactly the current step capability for that
  `effect` (see [artifact-format.md](artifact-format.md) and the action
  schema in the CLI source). The step must already be the scheduled one under
  an authorized plan — an action gate authorizes one call inside an approved
  plan, it is never a way to authorize work the plan review has not covered.

`approve` takes `--token` and `--decision`. A `compact` or `execution` gate
also requires `--readiness-confirmed C<n>`. An `action` gate must re-submit
both the same `--action-json <path>` and `--readiness-confirmed C<n>` used by
its check. Nothing else.

In particular, `approve` does **not** repeat the five Compact eligibility
flags. `check` already wrote those declarations into the `gate-prepared`
event, and the token is bound to that event, so any later ledger write
invalidates it — repeating them could not tell the CLI anything new. Passing
them to `approve` is a usage error. Readiness is the exception because it is
a fact about *this session* rather than about the task, so it is re-confirmed
at the moment authority is actually granted.

## Exit codes

`0` success (warnings allowed) · `1` unexpected internal failure · `2` usage
error · `3` the bundle or transition is invalid · `4` a stale, wrong, or
already-used approval token · `5` I/O, lock, or path-safety failure.

Exit `5` also covers losing a race: if another process wrote to the ledger
between this command's read and its append, nothing is written and the
command asks to be re-run. Retry it rather than editing the ledger by hand.

## Session-only mode

If Node 20+ or command execution is unavailable, do not silently skip gates.
Instead: state once, clearly, that nothing will be written to disk and
nothing here is resumable; still clarify, still resolve capabilities, still
present the same Compact/Full/action-gate cards in-conversation; still stop
on an uncertain external effect rather than guessing. Never claim `accepted`
in this mode — describe the session's result and its gaps instead.
