# Clarifying: the stop rule and question design

## The stop rule is the whole budget

Ask a question only while an unresolved item would change scope, a
capability, an `effect`, a dependency, or a success criterion. There is no
quota, minimum, or maximum — a fully specified request gets zero questions,
and a genuinely unclear one gets as many as it needs. Never display a
remaining-question count; a visible allowance gets spent, and a user reading
one treats the next question as owed.

Everything you decided without asking goes into the contract's `Assumptions`
table: the assumption, its basis, and what changes if it is wrong. This is
what the approval card actually reviews — not how many questions you asked,
but what you decided on the user's behalf.

## Designing one question

- Advance exactly one decision per turn.
- For a real closed choice, offer 2-4 mutually exclusive options, each with
  its consequence; put an evidence-backed recommendation first, never a bare
  menu with no reasoning.
- For an open question, ask one focused thing and say why it changes the
  plan; do not invent choices or steer toward one.
- Never ask for a credential, token, or secret. Ask the user to authenticate
  themselves, or to provide a redacted export.
- A vague delegation ("your call") does not confirm a decision that would
  change scope, a capability, effect, dependencies, or success criteria —
  present one concrete default and its consequence, then record the user's
  explicit acceptance.
- Re-ask a decision only if the prior answer was contradictory, partial, or
  withdrawn; a settled decision is not reopened.

## Portable choice cards

Never name a specific host tool (its selection-card mechanism, its slash
command, or its API) in this skill's own instructions. When the host exposes
a native selection card, use it for a real closed choice with 2-4 options;
otherwise render the same choice as plain text and end the turn. The binding
between "closed choice" and whatever mechanism this host actually offers is
this skill's own job to resolve at runtime, not something to hard-code.

## Late discoveries change the same contract, not a side channel

If the plan stage uncovers a fact that would have changed scope, a
capability, an effect, a dependency, or a success criterion, update
`contract.md`'s terms and get terms re-approved — the same rule as during
clarification, just later. Purely operational choices (step order,
intermediate format, how many steps) go straight into the plan for the user
to see on the plan-approval card; they do not need a separate question.
