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

`src/mcp.json` is the packaged MCP catalogue. At startup the adapter renders each entry into `[mcp_servers.*]` blocks in the Codex `config.toml`, enabling `experimental_use_rmcp_client` when any remote HTTPS server is present. Plaintext and placeholder URLs are skipped rather than shipped into the configuration. An `mcp.json` written by the admin console replaces the packaged catalogue entirely.

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

## Agent Profiles

A profile assembles a subset of the payload into a business-specific agent. One image serves every profile.

| Field | Effect |
| --- | --- |
| `name`, `display_name`, `description` | Identity, shown in the chat profile picker |
| `persona` | Appended to the base instructions |
| `skills`, `tools` | Restrict what the profile sees; absent means everything |
| `mcp_servers` | Restrict the rendered `[mcp_servers.*]` blocks |
| `model` | Override the model for this profile |

For a restricted profile the runtime builds a filtered view of the payload and points `DIGIBUDDY_SKILLS_ROOT` and `DIGIBUDDY_TOOLS_ROOT` at it; unrestricted profiles point straight at the payload. Filtering controls what the agent is offered, not what the sandbox can reach — Codex still has a shell, so it is a curation mechanism rather than a security boundary.

Chat clients select a profile with `metadata.profile` on the Responses request. Selecting nothing uses the runtime default.

## Admin Console

The Web UI serves `/admin`, a three-tab console over the configuration store covering model access, remote MCP servers, and agent profiles.

Access requires Easy Auth in front of the container; `requireAdmin` reads the `x-ms-client-principal` header and checks the caller against `ADMIN_PRINCIPAL_IDS`. An empty allowlist denies everyone rather than admitting everyone. Anonymous local access needs an explicit `ADMIN_ALLOW_ANONYMOUS=true` opt-in that is ignored when `NODE_ENV=production`.

The model API key is write-only: reads return `api_key_set` instead of the value, and saving with the field blank preserves the stored secret. Every write is audited to the log with the document name and the caller, without values. `catalogue.json` is read-only from the console.

## Artifact Delivery

Generated files such as PPTX, DOCX, XLSX, and PDF are uploaded to Azure Blob Storage and exposed through **user-delegation SAS** links, signed with the agent's Entra ID identity rather than an account key.

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

## Knowledge-Backed Responses

Skills under `DIGIBUDDY_SKILLS_ROOT` supply an internal knowledge base and document-generation playbooks. Internal knowledge is consulted first; Microsoft Learn MCP tools serve as the external fallback. Answers cite their sources.
