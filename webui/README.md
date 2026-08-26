# DigiBuddy Web UI

Standalone Next.js, React, and AG-UI client for the DigiBuddy Codex Hosted Agent.

## Local development

```bash
npm ci
npm run dev
```

Open `http://localhost:3000`. The chat window carries no connection settings. The Responses endpoint, key, model, and optional Foundry agent reference come from the variables listed in `environment.example` or from the `/admin` control plane.

The browser speaks AG-UI only to `/api/agent`. The Next.js route validates the endpoint, keeps server-configured keys out of browser responses, invokes the Foundry Responses API, and translates its stream into AG-UI events.

Set `AUTH_REQUIRE_CORPORATE_ACCOUNT=true` with `AUTH_TENANT_ID` and `AUTH_ALLOWED_UPN_DOMAINS` to accept native Microsoft Entra work accounts. Corporate B2B accounts can be admitted with matching `AUTH_ALLOWED_HOME_TENANT_IDS` and `AUTH_ALLOWED_EMAIL_DOMAINS`; this allows trusted employee accounts represented as `#EXT#` in the resource tenant while still rejecting Hotmail and untrusted guests. Authorisation reads the issuing tenant, the `idp` claim, and the verified sign-in address — never the Easy Auth provider label, which is `bearer` on Container Apps and `aad` on App Service.

`AUTH_TENANT_ID` accepts a comma-separated set, so one deployment can serve several trusted tenants.

### Admitting users from another tenant

An app registration is bound to the tenant that owns it. A user from a different tenant cannot authenticate against it unless either the registration is multi-tenant, or the account exists in the resource tenant as an external user:

> Selected user account does not exist in tenant '…' and cannot access the application '…' in that tenant. The account needs to be added as an external user in the tenant first.

Some tenants forbid a multi-tenant audience through an application management policy, in which case `AzureADMultipleOrgs` is rejected and B2B invitation is the supported route:

```bash
scripts/invite-production-users.sh alice@example.com bob@example.com
scripts/invite-production-users.sh --file users.txt --dry-run
```

Inviting an account is necessary but not sufficient: the guest still has to satisfy `AUTH_ALLOWED_EMAIL_DOMAINS` and `AUTH_ALLOWED_HOME_TENANT_IDS` before the app admits it.

## Console layout

The chat page is a two-pane console that fills the viewport (`100dvh`, so it stays full screen once mobile browser chrome hides). The left pane lists sessions; each one keeps its own thread id and Responses `previous_response_id`, so switching never mixes transcripts. Sessions live in browser storage under `digibuddy.sessions.v1` — double-click a title to rename, `×` to delete. The pane closes with the line *Powered by Codex on Microsoft Foundry Hosted Agent*; there are no connection settings to expose. The right pane renders the transcript as GitHub-flavoured Markdown with inline HTML sanitised on the way in.

Below 860px the session pane slides in as a drawer. The header button opens it and a backdrop closes it.

### Agent capability card

The header carries one control naming the agent the conversation is talking to. Opening it lists the profiles on offer and, for the selected one, the skills, tools, and MCP servers it can reach as grouped chips. `/api/profiles` resolves those names against the runtime-published `catalogue.json`: a profile that stores `null` inherits everything packaged, an explicit list is intersected with the catalogue, and disabled MCP servers are never advertised. Picking a profile travels to the agent as `metadata.profile`.

### Activity trail

Reasoning summaries, tool calls, and failures appear under the answer as one-line rows that expand on click. They travel from `/api/agent` as AG-UI `CUSTOM` events named `activity` rather than as tool-call or message events, so they never enter the transcript the console stores and mines for deliverables. Each row shows a status: running rows pulse, and an upstream error marks everything still running as failed. The trail is cleared at the start of each run and when switching sessions.

### Composer

Attach local files with the **+** button in the composer — images, PDF, Office documents, CSV, and plain text. Files are read in the browser as data URLs and sent as Responses `input_image` or `input_file` parts; anything without inline bytes, or beyond the 25 MB per-turn budget the hosted agent enforces, is dropped. The hosted agent writes them into the Codex workspace and appends their paths to the prompt. Attachments belong to the turn that sends them, so the tray empties on submit.

The effort selector next to **Send** sets the reasoning effort (`minimal`, `low`, `medium`, `high`) for the turn; leaving it on *Auto* sends no `reasoning` field and lets the runtime configuration decide. Changing the effort restarts the Codex engine through its configuration fingerprint.

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

At the end of each serialized turn, the hosted runtime detects new or changed deliverable files, stores them privately under the shared configuration store's reserved `artifacts/` prefix, and adds an invisible metadata record to the response. The console turns that record into same-origin `/api/artifacts/...` cards and removes internal `/workspace` references from the visible reply. Existing named code blocks and external file links remain supported for compatibility.

HTML and SVG render inside a fully sandboxed iframe, Markdown renders as a document, images and PDFs preview inline, text formats show their source, and Office/archive formats provide a download action. A text preview is capped at 2 MB; the underlying download remains available.

The preview is a floating window rather than a permanent column: the conversation keeps the full width until a deliverable exists and the reader opens it from the header count. The window can be dragged by its title bar, expanded to fill the viewport, and closed with its `×` or `Esc`.

## Admin console

`/admin` centrally manages the runtime: model access, remote MCP servers, and agent profiles that assemble skills and tools. Changes are written to a shared configuration store — Azure Blob (`DIGIBUDDY_CONFIG_URI`, Entra ID) or a directory (`DIGIBUDDY_CONFIG_DIR`) — that the hosted agent reads at each turn boundary, so no redeploy is needed.

The capability lists the console offers come from `catalogue.json`, published by the runtime at startup, so the console cannot offer a skill or tool the image does not ship.

Access is guarded by `requireAdmin`. A deployment can configure `ADMIN_USERNAME`, a scrypt `ADMIN_PASSWORD_HASH`, and a random `ADMIN_SESSION_SECRET` to show a dedicated administrator login mask and issue an eight-hour HttpOnly session cookie. When those values are absent, the existing Easy Auth allowlist in `ADMIN_PRINCIPAL_IDS` is used; an empty list denies everyone. The model API key is write-only — it is never returned to the browser, and leaving the field blank preserves the stored value.

Skills are deployed from a zip. A repository archive holding several skills, a shared library and helper scripts is accepted too: the console explodes it into one self-contained bundle per skill, following a `digibuddy-skills.json` manifest when the archive ships one. Every deployment is confirmed against a preview that writes nothing. Importing straight from a URL is off unless `SKILL_IMPORT_ALLOWED_HOSTS` names the hosts it may fetch from (for example `codeload.github.com`); the fetch is HTTPS-only, refuses private addresses, and re-checks every redirect hop.

Chat users pick a profile in the session panel — the only setting the chat window exposes; it travels to the agent as `metadata.profile`.

## Container

```bash
docker build -t digibuddy-webui .
docker run --rm -p 3000:3000 \
  -e FOUNDRY_AGENT_ENDPOINT=https://your-foundry-endpoint/responses \
  -e FOUNDRY_AGENT_API_KEY=replace-at-runtime \
  -e CODEX_MODEL_NAME=gpt-5.6-sol \
  digibuddy-webui
```

The image listens on port `3000` and uses Next.js standalone output. It can run on Azure Web App for Containers or any OCI-compatible container service.

For production, place secrets in the hosting platform configuration, leave the UI key field blank, and restrict `AGENT_ENDPOINT_ALLOWLIST` to approved endpoint suffixes.

On Azure App Service, set `FOUNDRY_AUTH_MODE=bearer` and leave
`FOUNDRY_AGENT_API_KEY` empty. The server uses the Web App's managed identity
to acquire a Foundry access token; grant that identity the `Foundry User` role
on the target project.
