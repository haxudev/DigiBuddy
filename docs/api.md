# API Reference

## Overview

DigiBuddy exposes two surfaces:

- The **Hosted Agent** speaks the Microsoft Foundry **Responses protocol `2.0.0`**. This is the upstream API, callable directly by any Responses-compatible client.
- The **Web UI** exposes an **AG-UI** SSE endpoint at `POST /api/agent` and a managed-deliverable endpoint at `GET /api/artifacts/<id>/<name>`. Both keep storage and Foundry credentials server-side.

## Hosted Agent (Responses `2.0.0`)

### Endpoint

The endpoint is provisioned by `azd up` and takes the form:

```text
https://<your-foundry-endpoint>/responses
```

### Authentication

Either an API key or a bearer token, selected with `FOUNDRY_AUTH_MODE`:

```http
api-key: <key>
```

```http
Authorization: Bearer <token>
```

### Request

```bash
curl -N -X POST "https://<foundry-endpoint>/responses" \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -H "api-key: <key>" \
  -d '{
    "model": "gpt-5.2-codex",
    "input": "What is the price of a Standard_D4s_v5 VM in East US?",
    "stream": true,
    "store": true,
    "agent": { "name": "digibuddy-codex", "version": "1" }
  }'
```

| Field | Description |
| --- | --- |
| `model` | Model name, matching `CODEX_MODEL_NAME` |
| `input` | User prompt text |
| `stream` | `true` for SSE, `false` for a single JSON response |
| `store` | `true` so the response can be resumed |
| `agent` | Target agent `name` and `version` |
| `metadata.profile` | Agent profile to assemble; omit for the runtime default |
| `previous_response_id` | Resumes a prior turn in the same Codex thread |

### Streaming events

The agent emits standard Responses events. The ones the Web UI consumes are:

| Event | Description |
| --- | --- |
| `response.created` | Carries `response.id`, used as the next `previous_response_id` |
| `response.output_text.delta` | Incremental assistant text in `delta` |
| `response.completed` | Final `response.id` |
| `response.failed` / `error` | Terminal failure |

### Multi-turn conversations

Pass the `id` from the previous response as `previous_response_id`. The adapter maps it to a Codex thread and calls `thread/resume`, so the workspace and conversation state carry over.

```bash
curl -N -X POST "https://<foundry-endpoint>/responses" \
  -H "Content-Type: application/json" \
  -H "api-key: <key>" \
  -d '{
    "model": "gpt-5.2-codex",
    "input": "If I run that VM 24/7 for a month, what would it cost?",
    "stream": true,
    "store": true,
    "previous_response_id": "resp_..."
  }'
```

## Web UI (`POST /api/agent`)

The Web UI route accepts an AG-UI `RunAgentInput` body and returns an AG-UI event stream as SSE.

### Request

```bash
curl -N -X POST "http://localhost:3000/api/agent" \
  -H "Content-Type: application/json" \
  -d '{
    "threadId": "thread-1",
    "runId": "run-1",
    "messages": [{ "id": "m1", "role": "user", "content": "Hello" }],
    "state": {},
    "tools": [],
    "context": [],
    "forwardedProps": {}
  }'
```

### Response events

| Event | Description |
| --- | --- |
| `RUN_STARTED` | Run accepted |
| `TEXT_MESSAGE_START` | Assistant message opened |
| `TEXT_MESSAGE_CONTENT` | Incremental `delta` text |
| `TEXT_MESSAGE_END` | Assistant message closed |
| `STATE_SNAPSHOT` | Carries `previousResponseId` for the next turn |
| `RUN_FINISHED` | Run completed successfully |
| `RUN_ERROR` | Run failed, with `message` and `code` |

Return the `previousResponseId` from `STATE_SNAPSHOT` in the next request's `state` to continue the conversation.

### Connection configuration

The upstream connection is resolved server-side from environment variables, with optional per-request overrides under `forwardedProps.connection`. See `webui/environment.example`:

| Variable | Description |
| --- | --- |
| `FOUNDRY_AGENT_ENDPOINT` | Responses endpoint URL |
| `FOUNDRY_AGENT_API_KEY` | API key or bearer token |
| `FOUNDRY_AUTH_MODE` | `api-key` or `bearer` |
| `FOUNDRY_AGENT_NAME` | Agent name, e.g. `digibuddy-codex` |
| `FOUNDRY_AGENT_VERSION` | Agent version; required when `FOUNDRY_AGENT_NAME` is set |
| `CODEX_MODEL_NAME` | Model name sent as `model` |
| `AGENT_ENDPOINT_ALLOWLIST` | Extra comma-separated host suffixes accepted as endpoints |
| `DIGIBUDDY_PROFILE` | Default agent profile when the caller does not pick one |

The connection also accepts a `profile` field. The route sends it as `metadata.profile` rather than in `agent`, because `agent` names the deployed Foundry agent while the profile selects what that agent assembles.

Every endpoint must be HTTPS and must match `services.ai.azure.com`, `openai.azure.com`, or a host listed in `AGENT_ENDPOINT_ALLOWLIST`. Outside production, `localhost` and `127.0.0.1` are also permitted.

## Web UI (`GET /api/profiles`)

Lists the profiles a chat user may pick. Public and unauthenticated: only `name`, `display_name`, and `description` are exposed, because personas and capability assembly are runtime concerns. An unconfigured or unreachable store returns an empty list, meaning "no profile choice".

```json
{ "profiles": [{ "name": "marketing", "display_name": "Marketing", "description": "…" }] }
```

## Web UI (`/api/admin/config`)

The admin console API over the shared configuration store. Both methods require an authorised caller.

### Authentication

When `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH`, and `ADMIN_SESSION_SECRET` are configured, the route requires the signed HttpOnly cookie issued by `/api/admin/session`. The password hash uses `scrypt$N$r$p$<base64url-salt>$<base64url-derived-key>`, and the session expires after eight hours. This mode takes precedence over Easy Auth.

Without dedicated password settings, the route reads the Easy Auth `x-ms-client-principal` header and matches the caller's Entra object ID or sign-in name against `ADMIN_PRINCIPAL_IDS`. An empty allowlist denies everyone. Outside production, `ADMIN_ALLOW_ANONYMOUS=true` admits an anonymous local caller.

| Status | Meaning |
| --- | --- |
| `403` | Caller is not an allowlisted administrator |
| `400` | Unknown document name, or a value that fails validation |
| `500` | The configuration store is unavailable |

### `GET`

Returns all five documents. `models.json` is redacted: `api_key` is removed and replaced with a boolean `api_key_set`.

### `PUT`

```json
{ "document": "profiles.json", "value": { "profiles": [{ "name": "marketing" }] } }
```

| Document | Validation |
| --- | --- |
| `models.json` | Endpoint must be HTTPS; a blank `api_key` preserves the stored secret |
| `mcp.json` | Server names match `[A-Za-z0-9._-]+`; URLs must be HTTPS |
| `profiles.json` | Names match `[a-z0-9-]+` and must be unique |

`catalogue.json` is published by the runtime and is not writable. `skills.json` is writable only through `/api/admin/skills`, so that a registry entry can never name a bundle the store does not hold. Each successful write is logged with the document name and the caller, without values.

### Store configuration

| Variable | Description |
| --- | --- |
| `DIGIBUDDY_CONFIG_URI` | Azure Blob container URI, accessed with a managed identity |
| `DIGIBUDDY_CONFIG_DIR` | Filesystem directory, for local development |
| `AUTH_REQUIRE_CORPORATE_ACCOUNT` | `true` to enforce the company-account policy |
| `AUTH_TENANT_ID` | Trusted Entra tenant ID, or a comma-separated set of them |
| `AUTH_ALLOWED_UPN_DOMAINS` | Comma-separated company UPN domains |
| `AUTH_ALLOWED_HOME_TENANT_IDS` | Comma-separated trusted corporate B2B home tenants |
| `AUTH_ALLOWED_EMAIL_DOMAINS` | Work-email domains allowed for trusted B2B accounts |
| `ADMIN_PRINCIPAL_IDS` | Comma-separated Entra object IDs or sign-in names |
| `ADMIN_USERNAME` | Dedicated `/admin` username |
| `ADMIN_PASSWORD_HASH` | Scrypt password hash; enables password login with the other dedicated settings |
| `ADMIN_SESSION_SECRET` | Random secret of at least 32 characters used to sign administrator sessions |
| `ADMIN_ALLOW_ANONYMOUS` | `true` to allow anonymous access outside production |

The hosted agent must be pointed at the same store for admin changes to reach it.

Generated deliverables also use this store under the reserved
`artifacts/<random-id>/<filename>` prefix. `GET /api/artifacts/<id>/<name>`
validates both path segments and proxies the private bytes with a strict content
type and sandbox policy. Append `?download=1` to request download disposition.

## Web UI (`/api/admin/skills`)

The centralised skills plane. A skill is uploaded once, deployed to the shared store, and loaded by every hosted agent whose profile assembles it. All methods use the same authentication and status codes as `/api/admin/config`.

### `GET`

Returns `{ "skills": [...] }`, the deployed registry.

### `POST`

`multipart/form-data` with the archive attached as `bundle`, plus optional `version` and `description` fields, which apply only when the archive yields exactly one skill.

The archive may be a single skill — a zip holding `SKILL.md` at its root, either flat or under a single directory that names the skill — or a whole repository carrying several. In the second case the console *explodes* it into one normalised, self-contained single-skill bundle per skill, each stored and registered on its own. See "Complex archives" below.

The console rejects an archive that is not a zip, is larger than 32 MB, expands beyond 128 MB, holds more than 2000 entries, contains a symlink or an unsafe path, or has no `SKILL.md` anywhere. It then stores the bytes at `bundles/<name>/<sha256>.zip` before the registry names them, and returns `{ "skill", "deployed", "skills", "layout", "notes" }`.

### `PATCH`

```json
{ "name": "seo-optimizer", "enabled": false, "description": "…" }
```

Disabling a skill withdraws it from every agent without deleting the bundle.

### `DELETE`

`?name=seo-optimizer` removes the entry and deletes its bundle.

Every deploy, enable, disable and withdrawal is logged with the skill name and the calling administrator.

## Web UI (`/api/admin/skills/preview`)

A dry run. Nothing is written, so an administrator can see what an archive would deploy — and what it would replace — before it does.

`GET` returns `{ "allowed_hosts": [...] }`, the hosts an archive may be imported from. An empty list means URL import is switched off, and the console hides it.

`POST` accepts either the same `multipart/form-data` as a deploy, or `{ "source": "https://…" }` to fetch the archive first. It returns `{ "layout", "notes", "skills": [{ "name", "description", "size", "sha256", "entries" }] }`, where `layout` is `single`, `manifest` or `discovered`.

## Web UI (`/api/admin/skills/import`)

`POST` with `{ "source": "https://…", "description": "…", "version": "…" }` fetches an archive and deploys it exactly as an upload would.

The network is never in the trust path: fetching only supplies bytes, and the archive is still stored content-addressed and still re-verified by the runtime. Even so, an unrestricted fetcher inside the console would be a server-side request forgery primitive, so importing is off until `SKILL_IMPORT_ALLOWED_HOSTS` names the hosts it may reach. Requests must be HTTPS, every redirect is re-checked against the allowlist rather than followed blindly, and a host that resolves to a private or link-local address is refused even if it is allowlisted.

### Complex archives

Many useful skills ship more than markdown — scripts, tools, a shared Python package. A repository archive is onboarded in one of two ways.

Without a manifest, the console discovers skills: every `SKILL.md` at the archive root or directly under `skills/<name>/`. A `SKILL.md` nested deeper is treated as an example inside a skill, not a skill of its own.

With a `digibuddy-skills.json` at the archive root, the repository says so itself:

```json
{
  "skills": [{ "name": "agent-maturity-assess", "path": "skills/agent-maturity-assess" }],
  "shared": [
    { "path": "src/agent_maturity", "as": "_lib/agent_maturity", "skills": ["agent-maturity-*"] }
  ],
  "entrypoints": [
    {
      "path": "scripts/amx.py",
      "module": "agent_maturity.cli",
      "call": "main",
      "skills": ["agent-maturity-*"]
    }
  ]
}
```

`shared` copies a directory into each selected skill, and `entrypoints` generates a small script that puts the vendored library on `sys.path` and calls into it. The result is that each skill is *self-contained*: it needs no `PYTHONPATH`, no MCP server and no sibling skill to run. Selectors are literal names or a single trailing `*`.

A skill's `description` comes from its `SKILL.md` frontmatter. A frontmatter `name` that contradicts the directory is refused rather than guessed at. Executable bits on scripts are preserved; every other mode bit is normalised, so a crafted archive cannot publish a setuid or world-writable file.

Because each skill becomes an ordinary single-skill bundle, none of this reaches the runtime: it still sees the simple case.

### How a deployed skill reaches an agent

The runtime reads `skills.json`, downloads each enabled bundle its profile allows, verifies the SHA-256 against the registry, and extracts it into `$CODEX_HOME/skills`. Extraction is staged and renamed, so a rejected bundle never leaves a partial skill. A skill baked into the image always wins over an upload of the same name, and the deployed set feeds the runtime fingerprint so a change replaces the Codex process rather than serving a stale skill.

## Capability packs

A developer ships one archive. The console explodes it into one
content-addressed artifact per declared capability, so the store, the registry
and the runtime installer stay one mechanism rather than three.

`digibuddy-skills.json` at the archive root declares what it carries:

```json
{
  "schema_version": 1,
  "skills": [{ "name": "pack-skill", "path": "skills/pack-skill" }],
  "tools": [{ "name": "reporter", "path": "tools/reporter", "module": "reporter.cli" }],
  "mcp_servers": [
    { "name": "pack-mcp", "path": "servers/pack-mcp", "entrypoint": "server.py", "runtime": "python" }
  ]
}
```

A pack may declare any combination, so a tool-only or MCP-only pack is valid.
Each artifact proves it is what it claims by containing its own entry point.

**An MCP declaration names a runtime and a path inside its own files, never a
command.** Allowing a command would let a pack run `/bin/sh -c` at Codex start.
For the same reason a declaration may not set `PATH`, `PYTHONPATH`,
`NODE_OPTIONS` or anything else that decides what runs, and may not embed a
value shaped like a credential — a manifest is readable by anyone who can read
the archive, so a secret written into one is already disclosed. A server that
needs a credential binds a profile slot instead.

### Approval

A skill is markdown the model reads, so enabling it is enough. A tool and an MCP
server are code, so they carry a second gate:

| State | Meaning |
| --- | --- |
| `enabled` | Should this capability be offered at all |
| `approved_sha256` | Which exact bytes may execute |

Both must hold, and the approval must name the digest currently in the store.
Redeploying different bytes therefore drops the approval rather than inheriting
consent given for other code. `PATCH /api/admin/skills` takes
`{ "name", "approve": true, "sha256" }` and refuses a digest that is not the one
deployed, so approving a stale listing fails instead of applying.

Deployment must also present the digest its preview reported. Preview and deploy
are separate requests and a URL import fetches the archive twice, so without it
the bytes an administrator read and the bytes that install can differ.

### What the supply chain proves

SHA-256 establishes **integrity**: the runtime re-verifies that the bytes it
installs are the bytes the registry names. It does not establish **origin** —
there is no signature, and deployment has one approver. A pack is trusted code
running in the agent's container, and should be reviewed as such.
