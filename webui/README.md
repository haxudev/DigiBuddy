# DigiBuddy Web UI

Standalone Next.js, React, and AG-UI client for the DigiBuddy Codex Hosted Agent.

## Local development

```bash
npm ci
npm run dev
```

Open `http://localhost:3000`. The chat window carries no connection settings. The Responses endpoint, key, model, and optional Foundry agent reference come from the variables listed in `environment.example` or from the `/admin` control plane.

The browser speaks AG-UI only to `/api/agent`. The Next.js route validates the endpoint, keeps server-configured keys out of browser responses, invokes the Foundry Responses API, and translates its stream into AG-UI events.

## Console layout

The chat page is a three-pane console that fills the viewport (`100dvh`, so it stays full screen once mobile browser chrome hides). The left pane lists sessions; each one keeps its own thread id and Responses `previous_response_id`, so switching never mixes transcripts. Sessions live in browser storage under `digibuddy.sessions.v1` — double-click a title to rename, `×` to delete. The middle pane renders the transcript as GitHub-flavoured Markdown with inline HTML sanitised on the way in. The right pane previews deliverables.

Narrow viewports keep the same conversation width instead of stacking the panes: below 1180px the deliverable pane slides in as a drawer, and below 860px the session pane does too. The header buttons open them and a backdrop closes them.

### Activity trail

Thinking summaries, tool calls, and failures appear under the answer as one-line rows that expand on click. They travel from `/api/agent` as AG-UI `CUSTOM` events named `activity` rather than as tool-call or message events, so they never enter the transcript the console stores and mines for deliverables. Each row shows a status: running rows pulse, and an upstream error marks everything still running as failed. The trail is cleared at the start of each run and when switching sessions.

### Composer

Attach local files with the **+** button in the composer — images, PDF, Office documents, CSV, and plain text. Files are read in the browser as data URLs and sent as Responses `input_image` or `input_file` parts; anything without inline bytes, or beyond the 25 MB per-turn budget the hosted agent enforces, is dropped. The hosted agent writes them into the Codex workspace and appends their paths to the prompt. Attachments belong to the turn that sends them, so the tray empties on submit.

**Thinking** sets the reasoning effort (`minimal`, `low`, `medium`, `high`) for the turn; leaving it on *Default* sends no `reasoning` field and lets the runtime configuration decide. Changing the effort restarts the Codex engine through its configuration fingerprint.

Backend failures surface as a dismissable card above the composer, separate from the transcript, with the upstream message intact.

### Ask-user cards

To ask the user a structured question, the agent emits a fenced `ask-user` block containing JSON:

````markdown
```ask-user
{
  "question": "Which format should the report use?",
  "type": "single",
  "options": [
    { "value": "pptx", "label": "PowerPoint deck", "description": "Best for a readout" },
    { "value": "md", "label": "Markdown" }
  ],
  "allowOther": true,
  "placeholder": "Describe another format"
}
```
````

`type` is `single`, `multi`, or `text`; a choice type with no options falls back to `text`. `options` accepts plain strings as shorthand for `{ value, label }`. `allowOther` adds a "Something else" choice that reveals a free-text field. The card replaces the block in the transcript, and the answer returns as an ordinary user message quoting the question. A block that cannot be parsed, or that carries no `question`, stays visible as raw Markdown rather than disappearing.

### Deliverable previews

Deliverables are recovered from the assistant text, so no extra transport is needed. A fenced code block becomes a deliverable when its info string names a file (`title=`, `file=`, `filename=`, `path=`, or a bare second word) or when it runs to eight lines or more; shorter unnamed snippets are treated as explanation. Links become deliverables when they end in a known extension (`pptx`, `docx`, `xlsx`, `pdf`, `csv`, `png`, `html`, …), which covers the SAS URLs the agent returns for generated files. HTML deliverables preview inside a fully sandboxed iframe, Markdown renders as a document, images display inline, and everything else offers a download link with a source toggle.

## Admin console

`/admin` centrally manages the runtime: model access, remote MCP servers, and agent profiles that assemble skills and tools. Changes are written to a shared configuration store — Azure Blob (`DIGIBUDDY_CONFIG_URI`, Entra ID) or a directory (`DIGIBUDDY_CONFIG_DIR`) — that the hosted agent reads at each turn boundary, so no redeploy is needed.

The capability lists the console offers come from `catalogue.json`, published by the runtime at startup, so the console cannot offer a skill or tool the image does not ship.

Access is guarded by `requireAdmin`: put Easy Auth in front of the container and list the allowed Entra object IDs in `ADMIN_PRINCIPAL_IDS`. An empty list denies everyone. The model API key is write-only — it is never returned to the browser, and leaving the field blank preserves the stored value.

Chat users pick a profile in the session panel — the only setting the chat window exposes; it travels to the agent as `metadata.profile`.

## Container

```bash
docker build -t digibuddy-webui .
docker run --rm -p 3000:3000 \
  -e FOUNDRY_AGENT_ENDPOINT=https://your-foundry-endpoint/responses \
  -e FOUNDRY_AGENT_API_KEY=replace-at-runtime \
  -e CODEX_MODEL_NAME=gpt-5.2-codex \
  digibuddy-webui
```

The image listens on port `3000` and uses Next.js standalone output. It can run on Azure Web App for Containers or any OCI-compatible container service.

For production, place secrets in the hosting platform configuration, leave the UI key field blank, and restrict `AGENT_ENDPOINT_ALLOWLIST` to approved endpoint suffixes.

On Azure App Service, set `FOUNDRY_AUTH_MODE=bearer` and leave
`FOUNDRY_AGENT_API_KEY` empty. The server uses the Web App's managed identity
to acquire a Foundry access token; grant that identity the `Foundry User` role
on the target project.
