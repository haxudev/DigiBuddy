# Capability taxonomy

This list is **closed**. Fourteen capabilities cover the work tasks this pack targets. A plan step names exactly one of them; anything outside the list means either the step is really two steps, or the taxonomy genuinely needs extending — which is a deliberate edit to this file, not something to improvise mid-task.

The list is closed for a reason: an open vocabulary cannot be resolved. If every step invents its own capability name, no inventory can ever say whether the machine supports it.

**When two seem to fit, name the outcome, not the mechanism.** Running a script to reshape a spreadsheet is `data-transform`; `run-code` is for steps where the execution itself is the point. Asking a specialist skill to research a market is `web-research` with that skill as the provider; `domain-expert` is for steps that need its judgement rather than its reach.

For each capability: what it means, what typically provides it, and what it costs you when nothing does.

---

### `ask-user`

Getting a decision, a preference, or missing information from the human.

**Providers:** a selection-card tool that takes a question plus enumerated options — most hosts have one, under a different name each; otherwise plain text in your reply. Resolve it the same way as anything else: by looking at your own tool list, not by assuming the name your last host used.
**Fallback:** ask in prose, then end the turn and wait. Never ask a question and keep working past it — the answer cannot arrive mid-turn, so anything after the question is built on a guess.
**Gap cost:** none for the capability, which is always available in some form. The cost lands on quality instead: without a card, a multi-part decision arrives as prose and comes back as "the second one, I think".

### `web-research`

Finding and reading public material on the internet: pages, articles, search results, public social or community discussion, feeds, repositories.

**Providers:** a dedicated research skill, a web search tool, a fetch tool, `curl`.
**Fallback:** ask the user for URLs or to paste the material.
**Gap cost:** the task becomes dependent on what the user supplies, and coverage must be reported as user-scoped rather than comprehensive.

### `browse-authenticated`

Reaching material behind a login, or interacting with a page rather than just reading it.

**Providers:** a browser-automation skill or tool with an existing session.
**Fallback:** ask the user to export or paste the content.
**Gap cost:** the highest-risk gap in research work, because it silently produces one-sided coverage. Whatever sits behind the login is invisible, and invisible is not the same as absent. Always disclose.

### `read-local-docs`

Reading files, directories, and repositories on the user's machine.

**Providers:** native read, glob, and grep tools.
**Fallback:** ask the user to paste the content.
**Gap cost:** you cannot verify claims against the user's own material, so conclusions stay hypothetical.

### `run-code`

Executing something to produce a result: a script, a query, a command.

**Providers:** a shell or command tool, plus an available runtime (`python`, `node`, `uv`, `bun`).
**Fallback:** produce the script and ask the user to run it and return the output.
**Gap cost:** every computed number becomes an estimate. Say so.

### `data-transform`

Reshaping, filtering, joining, or aggregating structured data.

**Providers:** `jq`, `python`, a spreadsheet tool, a database CLI, or a query tool.
**Fallback:** do it by hand for small inputs; for large ones, reduce scope and say the sample is not the population.
**Gap cost:** manual transformation does not scale and is error-prone above roughly a hundred rows.

### `author-content`

Producing the deliverable itself: the argument, the structure, the recommendation, the prose. The step where judgement is applied to gathered material.

**Providers:** you.
**Fallback:** none needed.
**Gap cost:** none — but this is the capability plans most often forget to name. A plan that runs from `data-transform` straight to `doc-convert` has no step where the thinking happens, so the thinking never gets a verification criterion and never gets a checkpoint. If the deliverable contains a judgement, that judgement is a step.

### `doc-convert`

Turning content into a required output format: documents, slides, spreadsheets, PDFs, images, audio, video.

**Providers:** `pandoc`, `ffmpeg`, an office-format library, a document-generation tool or skill.
**Fallback:** deliver markdown or plain text and say the requested format was not produced.
**Gap cost:** usually acceptable, but confirm — sometimes the format *is* the deliverable.

### `communicate`

Sending something to a person or channel outside this conversation: an email, a chat message, a calendar invite, a published post, a filed document.

**Providers:** a mail, chat, or calendar MCP server or skill; a publishing tool; a CLI with credentials.
**Fallback:** produce the exact content and recipient list and hand it to the user to send. This is often the better option regardless of capability.
**Gap cost:** low, because the fallback is good. The real hazard is the opposite one: this capability is almost always **irreversible and externally visible**, so any step naming it is high risk by definition and never runs without explicit approval.

### `version-control`

Reading or changing versioned history, branches, reviews, and releases.

**Providers:** `git`, a forge CLI such as `gh`, a forge MCP server.
**Fallback:** work on a copy and hand the user a change summary.
**Gap cost:** no audit trail, and no safe rollback point before a risky step.

### `cloud-ops`

Inspecting or changing infrastructure and hosted services.

**Providers:** a cloud CLI (`az`, `aws`, `gcloud`), `kubectl`, `terraform`, `docker`, a cloud MCP server, a cloud-specific skill.
**Fallback:** none worth pretending about. Produce the commands and hand them over for a human to run.
**Gap cost:** total for any step that changes infrastructure. Never simulate this one.

### `issue-tracker`

Reading or writing work items, tickets, wiki pages, and project boards.

**Providers:** a tracker MCP server or skill, a forge CLI, an API token plus `curl`.
**Fallback:** produce the content and let the user file it.
**Gap cost:** the work does not land where the team actually looks, so treat delivery as incomplete until it does.

### `delegate`

Handing a bounded sub-task to a separate agent with its own context.

**Providers:** a subagent or task tool.
**Fallback:** do it inline and accept the context cost.
**Gap cost:** long parallel work serialises and consumes the main context. Plan fewer, larger steps.

### `domain-expert`

Specialist knowledge or procedure that an installed skill already encodes — a methodology, a vendor's platform, a regulated process.

**Providers:** any installed skill whose description matches the domain.
**Fallback:** proceed generically and flag reduced confidence.
**Gap cost:** you will reinvent, worse, something the machine already had. **If a matching specialist skill is installed, routing through it is mandatory, not optional.**

---

## Runtime primitives

These are not task capabilities and never appear in a plan step. They are preconditions this pack itself depends on.

**`persist`** — writing files. Without it the entire state layer degrades to conversation only. That is survivable for a single session but must be disclosed once, up front, because the user's belief that the task is resumable would otherwise be false.

## Extending this list

Adding an entry means every existing plan's vocabulary changed. Do it when a genuinely new class of work appears — not to describe one task more precisely. `scripts/validate.mjs` rejects any capability used anywhere in the pack that is not defined here, so a drive-by addition in one skill will fail the build.