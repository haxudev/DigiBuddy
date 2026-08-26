# Recovery: when it applies, and how it resolves

## Recovery is narrow on purpose

Only two situations open a recovery, via `recover open --code ...`:

- **`unauthorized-work`** — you find output that predates the authorization
  that should have produced it.
- **`uncertain-effect`** — an external, non-retry-safe action's outcome is
  genuinely unknown (a timeout, a dropped connection, an ambiguous response).

Everything else is an ordinary correction, not an incident:

- An unapproved draft with a structural mistake — just fix it.
- A capability gap — resolve it per [capabilities.md](capabilities.md).
- Content drift after approval but before any step started — `needs-
  reapproval`, handled by the normal gates.
- A truncated final ledger line — `repair`, not recovery.

## Opening

`recover open` requires `--summary` and at least one `--output ref=effect`
naming what was found and its effect classification. If a step was running
when you discovered the problem, the CLI records which one; that attempt is
immediately quarantined — no longer "running," and never eligible to become
a completed result on its own.

## Resolving

`recover resolve` requires a `--decision` and a `--reconciliation`:

| Reconciliation | Meaning | Legal decisions |
| --- | --- | --- |
| `occurred` | the effect is confirmed to have actually happened | `revalidate` only — never `discard` |
| `confirmed-not-occurred` | confirmed it did *not* happen | `discard` or `revalidate` |
| `still-uncertain` | still don't know | `stop` only |

- **`stop`** ends the task; only read-only `status` and `repair` remain
  available afterward.
- **`discard`** — nothing before the recovery counts toward the current or
  any future revision; affected steps go back to pending under a fresh
  approval.
- **`revalidate`** — old output is untrusted input. A step whose result must
  still be relied on needs a fresh, currently-authorized `completed` event;
  an old `step-finished` is never reused as-is.

`occurred` is the one path that must never repeat the real action: once
resolved, add a plan step whose `action` only inspects the existing output
(never repeats it), get it authorized under the (possibly new) revision, and
close it with `step revalidate --basis recovery-occurred` — not `step
start`. The CLI enforces this on both routes: an ungated `step start` and a
gated `check --gate action` are both refused for a step whose output a
resolved `occurred` recovery named, until that revalidation exists. If you
cannot name a single step that matches the recorded output exactly, stop
rather than guess.

## Compact after recovery

A Compact task that has any resolved recovery must switch `mode` to `full`
and increment its revision before continuing — Compact is never used to
re-plan work already in flight. This is the one case where `needs-
reapproval`'s `next` is `upgrade-to-full` rather than a plain gate check.

## An interrupted step is not automatically recovery

Before assuming the worst, reconcile: open the named evidence for the
started step. If it proves completion, record `step-finished --outcome
completed`. If it proves the action never happened and the step is
`retry-safe`, record `failed` and retry once. Only when the real-world state
is still genuinely unknown do you open `uncertain-effect` recovery —
repeating an action whose effect is unknown can perform it twice.
