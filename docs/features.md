# Features

## Cloud-Hosted Runtime

DigiBuddy deploys to Microsoft Foundry as a Hosted Agent with `azd up`. Foundry owns the service boundary, session isolation, and identity; Codex app-server owns execution inside the sandbox.

- **Protocol**: Foundry Responses `2.0.0`
- **Execution engine**: Codex app-server, driven over stdio JSON-RPC
- **Sandbox**: `workspace-write`, rooted at `/workspace`
- **Web UI**: an independent Next.js + React + AG-UI container that proxies to the agent

## Agent Payload

Everything that gives the agent its personality and capabilities lives in `src/` and is baked into the image at `/opt/digibuddy`.

| Path | Env var | Contents |
| --- | --- | --- |
| `/opt/digibuddy` | `DIGIBUDDY_PAYLOAD_ROOT` | Persona `AGENTS.md`, `mcp.json`, `node_modules/` |
| `/opt/digibuddy/tools` | `DIGIBUDDY_TOOLS_ROOT` | Python tools, already on `PYTHONPATH` |
| `/opt/digibuddy/skills` | `DIGIBUDDY_SKILLS_ROOT` | Skill definitions, one `<name>/SKILL.md` each |
| `/workspace` | `CODEX_WORKSPACE` | Writable working directory |

The runtime concatenates the hosted-agent guardrails with the payload persona into the Codex base instructions at startup.

`/workspace` is per-container scratch that is never committed anywhere, but a skill cannot tell that from the inside — each turn runs in `/workspace/conversations/<id>`, where the sandbox masks `.git` with an empty read-only directory that looks like a repository to anything probing for one. Superclarity refuses to create its `.superclarity/` state in a git workspace that would track it, and asks the caller to confirm first — a question that costs a turn and has no useful answer here. Both the root and each conversation directory therefore get the ignore rule the skill looks for, appended to any existing `.gitignore` rather than replacing it.

## Turn Inputs

A turn may carry more than text. Responses `input_image` and `input_file` parts are written into `<workspace>/uploads` and their paths are appended to the prompt, so Codex opens attachments as ordinary files; a per-turn budget caps how much is materialised. A `reasoning.effort` of `minimal`, `low`, `medium`, or `high` overrides the configured thinking strength for that turn and restarts the Codex engine through its configuration fingerprint.

While the turn runs, the console renders a live activity trail from send time, before the first assistant token. It starts with a pulsing placeholder and elapsed timer; reasoning summaries and tool calls then stream back as Responses reasoning items and function calls. A reasoning row shows the newest line while it is still running, rows stay collapsed until opened, and animation respects `prefers-reduced-motion`.

## Tools

Codex exposes only a shell, so every payload tool is a Python module with a CLI entry point.

| Command | Purpose |
| --- | --- |
| `python -m cost_estimator` | Monthly/annual projections from an Azure retail unit price |
| `python -m fetch_url <url>` | Read a web page as Markdown (Jina Reader, HTTP fallback) |
| `python -m m365_cli '<command>'` | Microsoft 365 mail, calendar, OneDrive, and SharePoint |
| `python -m sharepoint download <link>` | Resolve and download a SharePoint/OneDrive sharing link |
| `python -m azure_blob upload <path>` | Publish a file and print a time-limited download URL |
| `python -m create_eml` | Write an RFC 5322 `.eml` file (does not send mail) |

## Remote MCP Servers

`src/mcp.json` is the packaged MCP catalogue. At startup the adapter renders each entry into `[mcp_servers.*]` blocks in the Codex `config.toml`. Plaintext and placeholder URLs are skipped rather than shipped into the configuration. Every server is rendered with `default_tools_approval_mode = "approve"`: the runtime answers a Foundry request with no interactive channel, so a tool that asks for approval can only ever be declined — admitting a server to the catalogue *is* the authorization decision. Codex's own default, `auto`, presumes an unannotated tool is destructive, which leaves most servers unusable here. A server may opt into a stricter Codex mode with `"tools_approval_mode"`, at the cost of its tools becoming unreachable. An `mcp.json` written by the admin console replaces the packaged catalogue entirely.

### Default Knowledge Base

The `foundry-iq` entry is the agent's default knowledge base: a Foundry IQ knowledge base on Azure AI Search, exposed over MCP as the single `knowledge_base_retrieve` tool. It plans and decomposes the query itself, runs hybrid retrieval across its knowledge sources, and returns cited passages.

The endpoint is protected by Microsoft Entra rather than an API key, so it is reached through the `mcp_http_proxy` stdio bridge instead of a bare HTTPS entry — the bridge mints a token for `https://search.azure.com/.default` from the container's managed identity on every call, which a static `bearer_token_env_var` could not do. The identity needs the **Search Index Data Reader** role on the search service, and the *search service's own* identity needs **Cognitive Services OpenAI User** on the Azure OpenAI resource its knowledge base names, otherwise retrieval fails with a `BadGateway` about authenticating to the model endpoint.

A broad retrieval can answer with hundreds of kilobytes in a single tool result, and the hosted runtime fails the whole turn on a result that large — the caller gets `server_error` and no answer at all. The bridge therefore caps the text it forwards at `MCP_HTTP_PROXY_MAX_TEXT_CHARS` (60,000 by default, roughly 15k tokens) and appends a marker saying how much was cut, so the model can tell a truncated passage list from an exhausted one.

Every remote server goes through the same bridge. Codex's built-in remote MCP client registered zero tools for `microsoft-learn` inside the Foundry sandbox even though the endpoint answers normally from that container, so the catalogue routes it through `mcp_http_proxy` with no `MCP_HTTP_PROXY_SCOPE`: an empty scope means the bridge sends no `Authorization` header, which is what a public endpoint expects. Plaintext URLs are still refused.

Codex starts an MCP server once per session and drops it for good if the handshake fails, so a single timeout while the container is warming up costs the knowledge base for the rest of that conversation — which reads to the user as the agent ignoring it. The bridge therefore retries a transient failure (a connection fault, or 408/425/429/5xx) up to three times with growing backoff, while a rejected request is reported immediately. `startup_timeout_sec` and `tool_timeout_sec` in the catalogue apply to every server whatever its transport; an out-of-range value is ignored rather than clamped, because a timeout quietly changed to something else is worse than Codex's own default. When a server does fail to start, the adapter logs the server name and Codex's reason, so a missing tool is diagnosable instead of invisible.

Every profile that restricts `mcp_servers` still lists `foundry-iq`, and `src/AGENTS.md` routes internal and field questions to it before the local `work_memory/` corpus and before Microsoft Learn.

## Runtime Configuration Store

Model access, the MCP catalogue, and agent profiles are data, not image contents. They live in a shared store that both the Web UI admin console and the hosted agent read.

| Document | Written by | Contents |
| --- | --- | --- |
| `models.json` | Admin console | Model name, endpoint, provider, API key |
| `mcp.json` | Admin console | Remote MCP server catalogue |
| `profiles.json` | Admin console | Agent profiles |
| `catalogue.json` | Runtime, at startup | Skills, tools, and MCP servers the image actually ships |

| Variable | Description |
| --- | --- |
| `DIGIBUDDY_CONFIG_URI` | Azure Blob container URI, read with the agent's Entra ID identity |
| `DIGIBUDDY_CONFIG_DIR` | Filesystem directory, for local development |
| `DIGIBUDDY_CONFIG_TTL_SECONDS` | Runtime cache lifetime, default `30` |

The runtime re-reads the store at turn boundaries. When the model settings or the selected profile change, it fingerprints the new configuration and restarts the Codex engine, so administrative changes take effect without a redeploy. Publishing `catalogue.json` from the runtime keeps the console from ever offering a capability the image does not contain.

A read reached through the console runtime API waits 15 seconds and is retried up to three times. A read that gives up is not an error the caller can act on — it falls back to the packaged defaults — so a single slow read means the session quietly runs without whatever an administrator configured, including MCP servers they enabled. A cold agent container reaches a console that may itself be scaling from zero, and the previous three-second budget was routinely too short for that: every document timed out and the session was configured entirely from the image. A `404` is an answer rather than a fault, so a document that is simply absent is not asked for again.

## Agent Profiles

A profile assembles a subset of the payload into a business-specific agent. One image serves every profile.

| Field | Effect |
| --- | --- |
| `name`, `display_name`, `description` | Identity, shown in the chat profile picker |
| `persona` | Appended to the base instructions |
| `skills`, `tools` | Restrict what the profile sees; absent means everything |
| `mcp_servers` | Restrict the rendered `[mcp_servers.*]` blocks |
| `model` | Override the model for this profile |
| `credential_bindings` | Which credential slots this agent's process receives |

For a restricted profile the runtime builds a filtered view of the payload and points `DIGIBUDDY_SKILLS_ROOT` and `DIGIBUDDY_TOOLS_ROOT` at it; unrestricted profiles point straight at the payload. Filtering controls what the agent is offered, not what the sandbox can reach — Codex still has a shell, so it is curation rather than a boundary.

Credentials are the part with teeth. A profile binds values to named slots, and the runtime hands a Codex process only its own profile's bindings; because switching profile already replaces the process, one agent's secrets are never present in another's environment. Values live in a document no read API returns, so the console reports which slots are set and offers to rotate or clear one.

### Addressing an agent

Type `@` at the start of an empty message to choose an agent, or use the control in the chat header. `@` uses the same highlighted suggestion menu as `/` skills: arrow keys move, Enter chooses, and Escape dismisses without clearing the composer. The choice belongs to the conversation, not to the browser tab: switching sessions follows it and a reload restores it.

A conversation stays with the agent it began with. Codex fixes a thread's base instructions when the thread starts, so nothing can change the agent mid-conversation without discarding the thread — and pretending otherwise is how a console ends up displaying one agent while another one runs. After the first turn the header reports the agent in force, and choosing another one starts a new conversation with it.

The runtime is the authority. Chat clients ask with `metadata.profile`, and every turn reports the profile actually resolved — including when a request contradicts an existing binding, and when a blank request resolved through a deployment default. Naming an agent that is no longer configured is an error rather than a silent fallback, because a conversation bound to a deleted restricted agent must not quietly resume with a different one's capabilities.

## Admin Console

The Web UI serves `/admin`, a three-tab console over the configuration store covering model access, remote MCP servers, and agent profiles.

Chat authentication can be limited to company accounts. With `AUTH_REQUIRE_CORPORATE_ACCOUNT=true`, the server admits a caller whose issuing tenant is trusted, whose identity provider is not a personal or social one, and whose verified sign-in address is in an allowed domain. Hotmail, other personal accounts, and untrusted guest tenants fail closed — including one presenting a company-looking address. The Easy Auth provider label is deliberately not part of the decision: it is `bearer` on Container Apps and `aad` on App Service, so requiring a particular value rejects valid employees.

Production deployments can configure `ADMIN_USERNAME`, a scrypt `ADMIN_PASSWORD_HASH`, and `ADMIN_SESSION_SECRET` to show a dedicated login mask and issue an eight-hour HttpOnly, SameSite cookie. This mode takes precedence over Easy Auth. When it is not configured, `requireAdmin` reads the Easy Auth `x-ms-client-principal` header and checks the caller against `ADMIN_PRINCIPAL_IDS`; an empty allowlist denies everyone. Anonymous local access needs an explicit `ADMIN_ALLOW_ANONYMOUS=true` opt-in that is ignored when `NODE_ENV=production`.

The model API key is write-only: reads return `api_key_set` instead of the value, and saving with the field blank preserves the stored secret. Every write is audited to the log with the document name and the caller, without values. `catalogue.json` is read-only from the console.

## Artifact Delivery

New or changed generated files are automatically written to the private shared store below `artifacts/` and represented as delivery cards in the Web UI. The browser downloads them through `/api/artifacts/<id>/<name>` and never receives a storage credential or an internal `/workspace` URL. Markdown, HTML, SVG, images, PDF, JSON, CSV, and text can be previewed in the delivery area; Office documents and archives remain downloadable.

The `azure_blob` tool still provides **user-delegation SAS** links for explicit external-sharing workflows such as links inserted into email.

A file that cannot be written is retried before it is given up on, and a turn that still ends with unsaved files reports how many in the same invisible manifest that carries the delivery cards. The console renders that as a dismissible notice under the answer rather than as a sentence inside it, so a storage outage does not become a permanent line in the transcript. The answer itself is delivered either way.

### HTML reports

A delivered HTML file may run its own scripts, so a report can draw charts. It is held in an opaque origin with no network: the preview grants `allow-scripts` but never `allow-same-origin`, and the bytes are served under `default-src 'none'`. Scripts run, but the page cannot read this app's cookies, call its API, or send what it is displaying anywhere.

That is why a CDN is not an option, and why the agent inlines instead. ECharts ships in the image at `$DIGIBUDDY_VENDOR_ROOT/echarts.min.js`, pinned by version and checked by digest at build time; the `html-report` skill tells the agent to read it and paste it into the page. The result is one self-contained file that renders in the preview, opens offline, and survives being forwarded. Server frameworks have no role here — nothing is serving the deliverable.

Because the library travels inside the file, a report starts at about a megabyte before any content, so the preview accepts up to 8 MB of text.

| Variable | Description |
| --- | --- |
| `DIGIBUDDY_BLOB_SERVICE_URI` | Blob service endpoint |
| `DIGIBUDDY_BLOB_CONTAINER` | Destination container |
| `DIGIBUDDY_BLOB_LINK_TTL_HOURS` | Link lifetime |

Binary email attachments are staged to Blob Storage automatically and rewritten into download links; plain-text files stay as direct attachments.

## M365 Workflows

The `m365_cli` tool provides Microsoft 365 operations from the runtime.

| Capability | Description |
| --- | --- |
| Email | Send and read email via Microsoft Graph |
| Calendar | Inspect calendar events |
| OneDrive | Browse and download files |
| SharePoint | Query sites and document libraries |

The `sharepoint` tool resolves sharing links through Microsoft Graph using MSAL, defaulting to app-only credentials and switching to on-behalf-of when a user assertion is supplied.

## Session Persistence

Each Responses conversation maps to a Codex thread. Passing `previous_response_id` resumes the thread with `thread/resume`, preserving workspace state and conversation history across turns.

Codex keeps that thread under `CODEX_HOME`, which does not outlive the session container, while the console keeps sending the response id that names it. When resuming fails the adapter opens a new thread in the conversation's existing workspace instead of failing the turn: losing the engine's memory of the conversation is recoverable, and the files it produced are still there, whereas the previous behaviour failed every later turn in that conversation the same way with no way back. A resume that fails because the engine itself died is not papered over — `_request` has already restarted it, and the next turn recovers against a live one.

A turn that fails part-way through now says why. Codex reports the reason on `turn/completed` and in its `error` notification, and the adapter used to discard all of it, so a rate limit, a context overflow and a crashed engine were indistinguishable from each other and reached the user as a bare internal server error. The reason is logged and, when the turn produced no other output, returned as the assistant's answer. `additionalDetails` is excluded because it can carry whatever a tool printed. A turn that ends empty with no reason given is still an error, because that is a bug rather than an answer.

Stored history can also become unsendable. Codex replays a reasoning item it reloaded from disk with `"content": null`, which the Azure model endpoint rejects as `invalid_payload` on `input[N].content` while api.openai.com accepts it ([openai/codex#15584](https://github.com/openai/codex/issues/15584), unfixed as of v0.149). The item is part of the thread, so once it appears every later turn in that conversation fails identically — this is the "it worked for a while and then only returned errors" report. The adapter recognises the endpoint's own description of the rejected payload, opens a new thread and runs the turn again once. The conversation loses the engine's memory, not the conversation. The recovery deliberately does not fire when anything has already been streamed to the user, or a second time, or for any other error: retrying a rate limit this way would discard a conversation's history for nothing.

## Knowledge-Backed Responses

Skills under `DIGIBUDDY_SKILLS_ROOT` supply an internal knowledge base and document-generation playbooks. Internal knowledge is consulted first; Microsoft Learn MCP tools serve as the external fallback. Answers cite their sources.
