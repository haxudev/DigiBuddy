# DigiBuddy

[English](README.md) | [简体中文](README.zh-CN.md)

> Codex coding runtime on Microsoft Foundry Hosted Agent.

DigiBuddy packages Codex app-server as the Coding Agent Runtime / Execution Engine inside Microsoft Foundry Hosted Agent. It exposes the Foundry Responses protocol `2.0.0` and includes an independent Next.js + React + AG-UI Web UI for container deployment.

On top of the runtime, this repository ships an agent payload that turns Codex into **DigiBuddy** — a Microsoft expert agent that helps developers, architects, and business users work with Azure pricing, documentation, internal knowledge, email workflows, SharePoint content, and generated deliverables.

**Core features**

- Deploy a protocol `2.0.0` agent through Microsoft Foundry
- Use Codex app-server for coding-agent loops, shell, Git, and file operations
- Resume Codex threads through persistent response/session mapping
- Configure model endpoint, key, and model name at runtime
- Administer models, remote MCP servers, and agent profiles from a Web UI console
- Assemble business-specific agents from profiles without rebuilding the image
- Connect through a standalone Next.js + React + AG-UI application
- Deploy the Web UI to Web App for Containers or any OCI-compatible host

## Agent Capabilities

- **Managed artifact delivery**: generated files are persisted in private shared storage and exposed through same-origin delivery cards with safe previews; external SAS links remain available only for explicit sharing workflows. If storage still fails after retry, the answer is delivered and the console shows a dismissible notice instead of writing a failure sentence into the transcript.
- **Live turn activity**: as soon as a message is sent, the console shows a pulsing activity placeholder and elapsed timer; reasoning then updates to the newest line while rows stay collapsed, with animation disabled for reduced-motion users.
- **Microsoft 365 workflows**: the `m365_cli` tool can send email, read mail, inspect calendars, browse OneDrive, and query SharePoint from the agent runtime.
- **Blob-backed email attachments**: binary attachments are automatically staged to Blob Storage and rewritten as clean download links; plain-text files stay as direct attachments.
- **SharePoint and OneDrive ingestion**: shared document links are resolved through Microsoft Graph, using app-only credentials by default and on-behalf-of when a user assertion is supplied.
- **Document and artifact generation**: the agent produces PPTX, DOCX, XLSX, PDF, HTML, Markdown, images, and data files under `/workspace`; new or changed deliverables are attached to the response automatically.
- **Knowledge-backed responses**: skills supply an internal knowledge base consulted ahead of the Microsoft Learn MCP tools, with source citations.
- **Cloud pricing and cost estimation**: live Azure retail pricing lookups plus monthly and annual projections.

## Project Structure

```
azure.yaml                    # Microsoft Foundry Hosted Agent manifest
hosted-agent/                 # Responses adapter and Codex execution runtime
├── Dockerfile                # Protocol 2.0.0 runtime image
├── main.py                   # Responses handler and stream adapter
├── AGENTS.md                 # Runtime guardrails
└── codex_adapter/            # Codex stdio JSON-RPC client, config, profiles, session map

webui/                        # Standalone Next.js + React + AG-UI application, incl. /admin console

src/                          # Agent payload, baked into the image at /opt/digibuddy
├── AGENTS.md                 # DigiBuddy persona and capability catalogue
├── mcp.json                  # Remote and local MCP server catalogue
├── skill-availability.json   # Which skills are built-in, on-demand, hidden or off
├── skills/                   # <name>/SKILL.md definitions loaded on demand
├── tools/                    # Python tools, each with a CLI entry point
│   ├── azure_blob.py         # Blob upload and user-delegation SAS links
│   ├── cost_estimator.py     # Pricing math helpers
│   ├── create_eml.py         # EML generation helper
│   ├── fetch_url.py          # URL ingestion helper
│   ├── m365_cli.py           # Mail, calendar, OneDrive, SharePoint operations
│   └── sharepoint.py         # Graph-based SharePoint/OneDrive access
├── scripts/                  # Install-time helpers for bundled dependencies
├── vendor/m365-cli/          # Repository-owned overrides applied after npm install
└── work_memory/              # Internal FAQ knowledge base (gitignored, supplied at build time)
```

The primary deployment is defined by `azure.yaml` and built from `hosted-agent/Dockerfile`. The `webui/` image is deployed separately and connects to the resulting Foundry Responses endpoint.

## Agent Payload

The Codex sandbox exposes only a shell — there is no tool registry. Capabilities are therefore delivered as files copied into the image and surfaced through environment variables:

| Path | Env var | Contents |
| --- | --- | --- |
| `/opt/digibuddy` | `DIGIBUDDY_PAYLOAD_ROOT` | Persona, `mcp.json`, `node_modules/` |
| `/opt/digibuddy/tools` | `DIGIBUDDY_TOOLS_ROOT` | Python tools, already on `PYTHONPATH` |
| `/opt/digibuddy/skills` | `DIGIBUDDY_SKILLS_ROOT` | Skill definitions |
| `/workspace` | `CODEX_WORKSPACE` | Writable working directory |

At startup the adapter concatenates `hosted-agent/AGENTS.md` with `src/AGENTS.md` into the Codex base instructions, and renders `src/mcp.json` into `[mcp_servers.*]` blocks of the generated Codex `config.toml`.

### Bundled workflow and assessment skills

The image contains immutable snapshots of Superclarity and Agent Maturity.
Superclarity is the default entry for multi-step, ambiguous, or consequential
work. It ships a Node CLI at
`skills/superclarity/scripts/superclarity.mjs` that owns task state, so the
image also carries a Node 22 runtime and the build fails if that CLI cannot be
loaded. Agent Maturity includes its zero-dependency Python runtime and is
registered as the local `agent-maturity` stdio MCP server.

Azure startup does not clone repositories or install these tools. To update the
locked snapshots deliberately:

```bash
scripts/sync-agent-skills.sh
scripts/sync-agent-skills.sh --check
```

The first command materializes the commits in
`hosted-agent/skill-sources.lock`; the second detects drift between those
commits and the tracked Docker build context.

### Skills

A skill is a directory holding `SKILL.md` and whatever it needs to do its job —
references, scripts, a vendored library, a CLI. Skills reach the agent through
three planes.

**How a skill is meant to arrive.** Most skills are not things a user picks.
`pptx` and `html-report` are things the agent should reach for the moment a
request needs them, and asking someone to type `/pptx` before they may have a
deck is asking them to know the implementation. So each skill declares one
availability in `src/skill-availability.json`:

| Availability | Installed | Named in the instructions | In the `/` menu |
| --- | --- | --- | --- |
| `builtin` | yes | yes, with its own trigger description | no |
| `command` (default) | yes | yes, by name | yes |
| `hidden` | yes | no | no |
| `off` | no | no | no |

A `builtin` skill loads itself: the instructions carry its description, so the
agent recognises the moment it applies without being told. A `hidden` one is
installed and reachable — a curated command may bundle it — but is neither
advertised to the model nor listed for the user; the four `agent-maturity-*`
skills are hidden behind the single `/agent-adoption-assessment` command. An
`off` skill stays in the repository and never reaches the image at all: it is
also excluded in `.dockerignore`, and the build fails if the two disagree.

A skill nobody declares is a `command`, which is what every skill was before
this file existed. That default matters for uploads: a bundle is untrusted
input and is never named in the declaration, so it can neither hide itself nor
promote itself into the instructions.

**Users** load an on-demand skill with a slash command. Typing `/` in the
composer opens a menu of the skills the current agent profile can reach; arrow
keys move the
selection, Enter picks it, and Escape dismisses the menu without disturbing what
has been typed. Picking one attaches it to the next message. Selection is per
message, not per conversation: a skill is markdown the model reads on demand, so
unlike the `@agent` mention — which Codex fixes when a thread starts — it can be
chosen at any point. The runtime resolves the request against the bound profile
and prefixes the turn with a directive naming the skill's `SKILL.md`. When the
catalogue cannot be read, the menu says so rather than appearing empty, because
"this deployment ships no skills" and "the configuration store is unreachable"
are different problems with different fixes.

Every skill a profile can reach and the runtime marks as a `command` is offered
automatically. A `commands.json`
document layers curation on top, so an administrator can rename a command, give
it a better description, hide one that has no business in a chat menu, or bundle
several skills under a single name — including a `builtin` or `hidden` skill,
because an administrator asking for a menu row knows better than the default.
`/agent-adoption-assessment` ships as a
built-in example: it loads `agent-maturity-assess` and `agent-maturity-report`.

**Administrators** upload skills from the console, as a zip or an HTTPS URL.
Bundles are content-addressed and stored under `bundles/<name>/<sha256>.zip`; the
runtime verifies the digest before extracting and refuses symlinks, path
traversal and oversized archives. Uploaded *code* — tools and MCP servers — stays
inert until an administrator approves the exact bytes, so replacing an approved
artifact revokes consent rather than inheriting it.

The console's Skills tab shows the whole inventory, separating the skills the
image loads by default from custom uploads, and each one has a switch. Turning a
skill off means the runtime stops installing it: no agent profile can reach it
and it leaves the `/` menu. The two halves are stored apart — an upload's switch
lives in its registry entry, a packaged skill's in `skill-policy.json` — because
they are different kinds of statement, and the runtime refuses an upload that
collides with a packaged name, so the two sets never overlap. Either way the
change applies from the next turn, when the runtime re-reads its configuration.

**Packages, not just prose.** A repository holding several skills, a shared
Python package and scaffolding is *exploded* into one self-contained bundle per
skill: shared libraries are copied into each skill and entrypoint shims are
generated, so a skill works with nothing on `PYTHONPATH`. Declare the layout in a
`digibuddy-skills.json` manifest at the archive root:

```json
{
  "schema_version": 1,
  "skills": [{ "name": "my-skill", "path": "skills/my-skill" }],
  "shared": [{ "path": "src/my_package", "as": "_lib/my_package" }],
  "entrypoints": [{ "path": "scripts/run.py", "module": "my_package.cli", "call": "main" }]
}
```

Without a manifest the importer still discovers any directory holding a
`SKILL.md`, but it cannot know that `src/my_package/` is the code those skills
import — each bundle is extracted alone, so anything outside it is simply
absent. The upload preview warns when a package would be left behind.

### Skills and MCP servers

A skill may be **accelerated** by an MCP server, but must never **require** one.

MCP servers are process-level. They are written into the generated Codex
`config.toml` and started with the engine, and the rendered config is part of the
runtime fingerprint — so changing the set restarts Codex for the whole container,
which serves every conversation through one process. That is fine at deploy or
admin time and unacceptable per turn, which is why a slash command never touches
it.

So a skill carries its own runtime: a vendored `_lib/` and a `scripts/` shim it
can invoke from the shell. That path costs nothing, works in any profile, and
works for uploaded skills with no MCP wiring at all. Where a server *is*
registered it is scoped to the profiles that need it — the `agent-adoption`
profile carries `agent-maturity`, and the assessment still runs everywhere else
through the skill's own CLI.

### Tools

Every payload tool is a Python module invoked from the shell:

```bash
python -m cost_estimator --unit-price 0.192 --unit-of-measure "1 Hour" --quantity 730
python -m fetch_url https://example.com/article
python -m m365_cli 'mail list --top 5 --json'
python -m sharepoint download <share-url> --out /workspace
python -m azure_blob upload /workspace/report.pdf
python -m create_eml --out /workspace/message.eml --from a@b.com --to c@d.com \
  --subject "Hi" --body "Hello"
```

To add a tool, drop a module into `src/tools/` with an `argparse`-based `main()` and a `if __name__ == "__main__"` guard, then document it in `src/AGENTS.md`. Add any Python dependencies to `src/requirements.txt`.

## Admin Console and Agent Profiles

Model access, the remote MCP catalogue, agent profiles, and private response artifacts live in a shared store — an Azure Blob container (`DIGIBUDDY_CONFIG_URI`) or a directory (`DIGIBUDDY_CONFIG_DIR`) — that both the Web UI and the hosted agent can access. Artifacts use a reserved `artifacts/` prefix and unguessable identifiers; the browser receives only same-origin `/api/artifacts/...` references.

The Web UI serves `/admin`, a three-tab console over that store:

| Tab | Manages |
| --- | --- |
| Model access | Model name, endpoint, provider, and API key |
| Remote MCP | The HTTPS MCP server catalogue |
| Agent profiles | Persona plus the skills, tools, MCP servers, and model each profile assembles |

The runtime re-reads the store at each turn boundary and restarts the Codex engine when the effective configuration changes, so administrative edits take effect without a redeploy. At startup it also publishes `catalogue.json`, describing the skills and tools the image actually ships, so the console can never offer a capability that is not deployed.

Chat users choose an agent from the control in the chat header. The choice travels to the runtime as `metadata.profile`, and the runtime answers with the profile it actually resolved. Because Codex fixes a thread's base instructions when the thread starts, a conversation stays with the agent it began with: after the first turn the control reports that agent, and choosing another one starts a new conversation. Choosing nothing uses the runtime default; naming an agent that is no longer configured is an error rather than a silent fallback.

Chat sign-in can be restricted to company accounts with `AUTH_REQUIRE_CORPORATE_ACCOUNT`, `AUTH_TENANT_ID`, and `AUTH_ALLOWED_UPN_DOMAINS`. Trusted corporate B2B accounts are added through `AUTH_ALLOWED_HOME_TENANT_IDS` and `AUTH_ALLOWED_EMAIL_DOMAINS`, while Hotmail and untrusted guests remain blocked. The check reads the issuing tenant, the `idp` claim, and the verified sign-in address rather than the platform's Easy Auth provider label, which differs between hosts.

`/admin` can require a dedicated username/password login using `ADMIN_USERNAME`, a scrypt `ADMIN_PASSWORD_HASH`, and `ADMIN_SESSION_SECRET`; this mode takes precedence over the Easy Auth allowlist. Without those values, access falls back to the Entra allowlist in `ADMIN_PRINCIPAL_IDS`, where an empty list denies everyone. The model API key is write-only — it is never returned to the browser, and leaving the field blank preserves the stored value. See [Features](docs/features.md) and the [API Reference](docs/api.md).

## Deploying the Foundry Hosted Agent

```bash
azd auth login
azd env set CODEX_MODEL_ENDPOINT "https://your-resource.openai.azure.com/openai/v1"
azd env set CODEX_MODEL_API_KEY "<model-key>"
azd env set CODEX_MODEL_NAME "gpt-5.6-sol"
azd env set CODEX_REASONING_EFFORT "medium"
azd up
```

The Codex sandbox has outbound network access by default
(`CODEX_NETWORK_ACCESS=true`), which requires
`CODEX_SANDBOX=workspace-write`. Set it to `false` to disable sandbox egress.

Then deploy `webui/Dockerfile` to Web App for Containers or another OCI host and set `FOUNDRY_AGENT_ENDPOINT`. See [Quickstart](docs/quickstart.md) and [Architecture](docs/architecture.md).

For routine updates after initial provisioning, use the repository release
orchestrator:

```bash
python scripts/release-hosted-agent.py
```

It publishes immutable Hosted Agent and Web UI images, creates and verifies the
new Foundry Agent version, updates the Web App, and writes a non-secret receipt
under `.azure/releases/`. Use `--fast` to skip local Docker validation,
`--build-only` to stop after image publication, or `--skip-webui` for an
intentional Agent-only release.

## Using the API

The Hosted Agent speaks the Foundry Responses protocol `2.0.0`:

```bash
curl -N -X POST "https://<foundry-endpoint>/responses" \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -H "api-key: <key>" \
  -d '{
    "model": "gpt-5.6-sol",
    "input": "What is the price of a Standard_D4s_v5 VM in East US?",
    "stream": true,
    "store": true,
    "agent": { "name": "digibuddy-codex", "version": "1" }
  }'
```

Pass the previous response `id` as `previous_response_id` to resume the same Codex thread. See the [API Reference](docs/api.md) for the full event list and the Web UI's AG-UI endpoint.

## Bundled Dependency Patches

This repository patches selected `m365-cli` files, managed outside `node_modules`:

- Source-controlled overrides live under `src/vendor/m365-cli/`.
- `src/scripts/apply-m365-cli-patches.mjs` copies those files into `node_modules/m365-cli/` after install.
- `src/package.json` runs the patch step automatically through the `postinstall` script.

## Local checks

```bash
cd hosted-agent && python -m unittest discover -s tests -t . -v
cd ../webui
npm test
npm run lint
npm run build
```

## Known Limitations

- **No video generation.** No rendering toolchain is installed in the agent image.
- **Windows is not supported** for the packaging hooks; use macOS, Linux, or WSL.
