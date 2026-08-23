# The discovery log

Every discovery prompt is an event in the brief's `Discovery log`. The log exists
because a count could not carry the thing that matters. `discovery_prompts: 3`
said nothing about whether those three questions were worth a user's turn, and it
punished a twelve-dimension domain profile for asking twelve necessary questions
while permitting the same question three times.

So the count is gone, and with it every fixed ceiling. What is left is the record.

## Writing an event

Append the row **before** putting the question, with outcome `pending`, then
update it when the answer arrives. A question asked but never written down
disappears when the session is compacted, and the next turn re-asks it.

| Column | What it carries |
| --- | --- |
| `ID` | `Q1`, `Q2`, ... in the order asked, no gaps, no reuse |
| `Revision` | the brief revision this prompt belongs to; earlier revisions' rows stay |
| `Trigger` | why the question exists, from the list below |
| `Affected decisions` | one or more required dimensions, or `profile-selection`, or `precedence` |
| `Blocking consequence` | what cannot be planned until this is settled |
| `Asked at` | ISO 8601 with an offset or `Z` |
| `Outcome` | `pending`, `answered`, `partial`, `contradicted`, or `withdrawn` |

Triggers: `request-silent` when the request never addressed it;
`contradiction` when two answers disagree; `profile-selection` when several
domain profiles plausibly match; `option-infeasible` when the approach the user
implied has no visible provider; `vague-delegation` when "use your judgment"
arrived on something that cannot be assumed.

`Blocking consequence` is the stop rule written down. If you cannot state what
stays blocked, the question is not worth asking, and no row should exist.

## What is not a discovery prompt

Brief approval, information the user volunteered without being asked, and a
revision the user initiated are all user turns, and none of them is a question
you chose to spend. They never get a row. In the closure table they carry their
own basis instead:

| Basis | Means |
| --- | --- |
| `request: <evidence>` | the request itself settled this |
| `discovery:<ID>:<ISO>: <evidence>` | the named event settled it |
| `volunteered:<ISO>: <evidence>` | the user supplied it unprompted |
| `revision:<ISO>: <evidence>` | a user-initiated revision changed it |

A `discovery:` basis must name a row whose `Affected decisions` include that
dimension and whose outcome is `answered` or `partial`, and its timestamp cannot
precede the row's `Asked at`. This is the only thing keeping the log and the
closure honest about each other.

## Asking again

Re-ask a decision only when the previous round left it open — `partial`,
`contradicted`, or `withdrawn`. Re-opening something already `answered` is churn,
and it is rejected: the user settled it, and asking again spends their turn to
learn what the brief already records.

## When to stop

There is no number. Keep asking while an unresolved item would change scope,
providers, dependencies, risk, success criteria, or the shape of the deliverable.
Stop when none remains. Most requests reach that point in one or two questions,
and a complete one reaches it in none.

Because there is no ceiling, the pressure that used to come from a budget has to
come from somewhere else. When the same decision comes back `partial` a second
time, the interview is not converging, and continuing to probe it is how a
clarification turns into an interrogation. Stop and put the situation to the
user: continue, accept a stated default and its consequence, narrow the scope so
the question stops mattering, or pause.

## What to show

Show which required decisions are still unresolved and which one this prompt
settles. Never show a remaining quota. A counter that looks like an allowance
gets spent: an agent with two prompts left finds two questions to ask, and a user
watching `2/3` reads a third question as owed rather than as a cost.

## The approval gate

A brief moves to `awaiting-approval` only when no event is still `pending`, and
an unresolved `contradicted` event must be matched by `pending_precedence` in the
frontmatter. A question the user has not answered cannot be part of something you
are asking them to approve.
