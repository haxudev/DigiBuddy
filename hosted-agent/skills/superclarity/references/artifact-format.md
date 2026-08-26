# Artifact format: `contract.md` and `acceptance.md`

Both files are a constrained Markdown subset, not arbitrary prose: exact
section headings in order, closed tables, and a fixed step-block grammar.
`skills/superclarity/scripts/model.mjs` parses this shape; a section the
parser cannot recognize is a structural error, not a style choice.

## `contract.md`

```yaml
---
schema: superclarity-contract/1
task: <slug>
mode: compact | full
revision: 1
created_at: <ISO-8601 with milliseconds>
---
```

Sections, in this order, each exactly once:

1. `## Objective` — `### Problem and current state`, `### Outcome and audience`.
2. `## Scope` — `### In`, `### Out`, each a `- ` list with at least one item.
   `Out` may not be a bare "none"; say why nothing else is excluded.
3. `## Constraints` — a table with exactly these five rows, once each:
   `Deadline`, `Effort or budget ceiling`, `Output format`,
   `Permitted sources`, `Access and exposure`. Use `none` for an unconstrained
   row, never leave it blank.
4. `## Success criteria` — `| ID | Criterion | Verification |`, `K1`, `K2`,
   ... Verification must name an observable check, not "looks good."
5. `## Assumptions` — the literal `none`, or a table `| ID | Assumption |
   Basis | If wrong |` (`A1`, ...). Anything that would change scope, a
   capability, an effect, a dependency, or a success criterion belongs in a
   question, never here.
6. `## Capability bindings` — `| ID | Need | Primary | Readiness | Evidence |
   Fallback | Use fallback when | Consequence |` (`C1`, ...). See
   [capabilities.md](capabilities.md) for the readiness values and what each
   column must say.
7. `## Execution plan` — before terms approval, exactly the sentence `Pending
   until terms approval.`; otherwise one or more steps:

   ```markdown
   ### S1 - <imperative title>
   - capability: C1
   - action: <what will happen>
   - verify: <the exact observable check>
   - effect: none | read-external | send | publish | payment | infra-change | destructive
   - depends-on: none | S<earlier id>[, S<earlier id>...]
   - output: <artifact or state; defaults to verify's text>
   - reversible: yes | no   (required unless effect is none)
   - retry-safe: yes | no   (default no)
   - gate: n/a | <what the action gate must show>   (required when effect needs a gate)
   ```

   A step never repeats `provider` or `fallback` — those live once on the
   capability row. `payment` must be `reversible: no`.

## `acceptance.md`

This file records whether the work is accepted; it is never the deliverable
itself. That is what the `Location` column is for: every deliverable is a
separate user-facing file outside `.superclarity/`, and this table says where. An
acceptance record that contains the deliverable has, by construction, no
deliverable to point at.

```yaml
---
schema: superclarity-acceptance/1
task: <slug>
contract_revision: <matches the current contract>
created_at: <ISO-8601 with milliseconds>
---
```

The one `#` heading is `# Acceptance record: <title>`. Sections, in order:
`## Outcome summary` (one or two sentences — the detail belongs in the
deliverables, not here), `## Deliverables`
(`| ID | Location | Purpose | Evidence |`, `D1`, ...), `## Success criteria`
(`| ID | Result | Evidence | Explanation |`, result is `yes`/`no`/`partial`),
`## Coverage and gaps` (a single `none` row, or real gap rows — never both),
`## Deviations and recovery`, `## Remaining actions` (each `none` or prose).

**Evidence** is one or more `;`-separated references:

- `L<seq>` — a ledger event (`step-finished`, `step-skipped`, or
  `step-revalidated`) for that step. A `yes` result may only cite a
  completed/revalidated event, never a skip or a failure.
- `<workspace-relative-path>@<first 12 hex of its current SHA-256>` — a
  direct file check.

`accept` re-hashes every reference and every completed step's recorded file
evidence; anything stale blocks acceptance (or, for a previously accepted
task, ends `accepted`) until you revalidate it.
