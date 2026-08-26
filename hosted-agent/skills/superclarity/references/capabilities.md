# Capabilities: preflight, readiness, and gaps

## Preflight is visibility, not readiness

At the start of a session, before any question, read what is already in
context: the tools, skills, and subagents the host exposes, and which
selection-card mechanism it offers. This costs nothing and prevents offering
an option this machine cannot deliver. It never runs a command, reads
configuration, logs in, installs anything, or touches task data — that is
survey's job, after a need is named.

## Naming a need

A capability row is free-form: name what the task actually needs in plain
language (`Read the local source file`, `Pay the approved invoice`, `Post to
the team channel`). There is no fixed vocabulary to pick from. Give it a
stable `C<n>` id; once a plan step references it, keep the id even if wording
around it changes — a step's identity for carry-forward purposes depends on
this id staying attached to the same need.

## Readiness values

| Value | Meaning | Usable for execution? |
| --- | --- | --- |
| `ready` | confirmed in this session, including any required login, permission, and quota | yes |
| `unverified` | only seen by name, not confirmed | no |
| `gap` | no usable provider at all | no |
| `resolved-manual` | user will supply the material directly | yes |
| `resolved-substitute` | a confirmed, weaker alternative is in use | yes |
| `resolved-drop` | the affected scope was removed instead | step must not reference this id |

Compact requires every capability the plan uses to be `ready`. Full's terms
gate accepts any readiness so the user can approve the objective alongside
known gaps; execution requires each capability the plan actually uses to be
executable.

`ready` is a session fact, not a permanent cache: re-confirm it before a
Compact/execution gate and again whenever a step starts in a resumed
session — pass the ids you just re-checked via `--readiness-confirmed`. A
capability being visible by name is never enough on its own.

## Closing a gap

Exactly four paths, and only the user decides which:

1. The user installs or authenticates, then you recheck and it becomes
   `ready`.
2. The user supplies material manually — record this as `resolved-manual`.
3. A confirmed, weaker substitute is accepted — `resolved-substitute`, naming
   the coverage or accuracy it costs.
4. The scope is dropped — `resolved-drop`, naming what the result can no
   longer establish.

Never install a provider yourself before the user has approved doing so, and
never treat "I could install this" as readiness. Any gap resolution that
changes scope, effect, dependencies, or success criteria means revising the
contract's terms and getting them re-approved, not quietly editing the
capability row alone.

## Fallback

A capability's `Fallback` column names an alternative for the *same* need —
not a second, hidden plan. It must keep the same `effect`, `reversible`, and
`retry-safe` meaning as the step that uses it; if the real fallback behaves
differently, that is a new step, not a fallback. `Use fallback when` states
the trigger in plain language; you judge whether it has occurred, you are not
asked to encode it as a formula. When the declared effect needs an action
gate, invoking the fallback still goes through `check --gate action
--binding fallback --reason ...` — never `step fallback` directly.
