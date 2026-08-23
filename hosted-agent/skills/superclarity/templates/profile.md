# Profile: <domain name>

- **Profile id:** <profile-id matching the file name>
- **Base profile:** none | built-in:<profile-id>@sha256:<64 lowercase hex> | user:<profile-id>@sha256:<64 lowercase hex>

Copy this file, rename it to `<profile-id>.md`, and fill in the four sections. Put it in `profiles/` alongside the shipped profiles, or in `.superclarity/profiles/` inside a project when the profile is specific to that work. A project profile with the same id wins. This file stays in `templates/` so that nothing can select it as a profile.

**A profile carries domain knowledge and nothing else.** No instructions about how to ask questions, how to size a plan, how to journal, or when to seek approval — the generic layer already owns all of that, and a profile that restates it will drift out of sync and start contradicting it. The validator rejects a profile that names any skill in this pack, which is the mechanical form of the same rule.

The validator also requires both control fields above, a dimension table whose every row carries a stable id and a deferrable cell, and a profile short enough to stay readable. A profile is a working reference, not an archive: when it fills up, merge or replace an item rather than appending another one.

The test: could a domain expert who has never seen this pack read your profile and recognise it as an accurate description of their field? If yes, it is a profile. If it reads like process instructions, it is not.

Delete this preamble when you write yours.

---

## Dimensions to clarify

The unknowns specific to this domain that change the shape of the work. These sit on top of the universal ones — outcome and audience, scope boundary, constraints, done criteria — never in place of them.

Give each dimension the *consequence* of leaving it unsettled. A dimension listed without its cost gets skipped whenever time is short. Mark a dimension deferrable only when settling it later cannot change scope, provider, dependencies, risk, or success; the table is the only list of dimensions, so anything missing from it is not a dimension.

| Dimension | Deferrable | Why it decides the shape of the work |
| --- | --- | --- |
| **[<stable-id>] <domain unknown>** | no | <what specifically goes wrong when it stays unresolved> |

## Step skeleton

A starting shape for the work, not a script to follow literally. State plainly that steps already settled by the brief should be merged or deleted, so nobody performs a discovery step for something already decided.

Keep it to five to eight steps. A skeleton longer than that is a procedure manual, and it will be copied mechanically.

1. **[step-<stable-id>] <step name>** — <what it produces and why it comes at this point>
2. **[step-<stable-id>] <step name>** — <what it produces and why it comes at this point>

## Acceptance criteria

What "good" means in this domain, in checkable terms. Someone who was not involved must be able to test each line.

Prefer criteria a domain expert would actually apply over generic quality language. "Every claim is sourced" is universal; "prices are all on one stated basis" is domain knowledge.

- **[criterion-<stable-id>]** <checkable criterion>
- **[criterion-<stable-id>]** <checkable criterion>

## Known pitfalls

Mistakes that are specific to this domain, and common enough to be worth naming. For each, say what it looks like from the inside — pitfalls are only avoidable if they are recognisable while they are happening.

Put the most damaging one first.

**[pitfall-<stable-id>] <Short name for the mistake>.** <What it looks like, why it is tempting, what it costs, and how to avoid it.>

**[pitfall-<stable-id>] <Short name for the mistake>.** <Same.>
