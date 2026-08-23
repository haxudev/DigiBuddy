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

- **Azure Blob artifact delivery**: generated files are uploaded to Azure Blob Storage and exposed through user-delegation SAS links signed with the agent's Entra ID identity, so no account key is ever used.
- **Microsoft 365 workflows**: the `m365_cli` tool can send email, read mail, inspect calendars, browse OneDrive, and query SharePoint from the agent runtime.
- **Blob-backed email attachments**: binary attachments are automatically staged to Blob Storage and rewritten as clean download links; plain-text files stay as direct attachments.
- **SharePoint and OneDrive ingestion**: shared document links are resolved through Microsoft Graph, using app-only credentials by default and on-behalf-of when a user assertion is supplied.
- **Document and artifact generation**: the agent produces PPTX, DOCX, XLSX, and PDF deliverables under `/workspace` and delivers them through download links.
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
work. Agent Maturity includes its zero-dependency Python runtime and is
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

Model access, the remote MCP catalogue, and agent profiles are data rather than image contents. They live in a shared configuration store — an Azure Blob container (`DIGIBUDDY_CONFIG_URI`) or a directory (`DIGIBUDDY_CONFIG_DIR`) — that both the Web UI and the hosted agent read.

The Web UI serves `/admin`, a three-tab console over that store:

| Tab | Manages |
| --- | --- |
| Model access | Model name, endpoint, provider, and API key |
| Remote MCP | The HTTPS MCP server catalogue |
| Agent profiles | Persona plus the skills, tools, MCP servers, and model each profile assembles |

The runtime re-reads the store at each turn boundary and restarts the Codex engine when the effective configuration changes, so administrative edits take effect without a redeploy. At startup it also publishes `catalogue.json`, describing the skills and tools the image actually ships, so the console can never offer a capability that is not deployed.

Chat users pick a profile in the settings panel; it travels to the agent as `metadata.profile`. Selecting nothing uses the runtime default.

Access is guarded by an Entra allowlist over the Easy Auth principal header (`ADMIN_PRINCIPAL_IDS`); an empty list denies everyone. The model API key is write-only — it is never returned to the browser, and leaving the field blank preserves the stored value. See [Features](docs/features.md) and the [API Reference](docs/api.md).

## Deploying the Foundry Hosted Agent

```bash
azd auth login
azd env set CODEX_MODEL_ENDPOINT "https://your-resource.openai.azure.com/openai/v1"
azd env set CODEX_MODEL_API_KEY "<model-key>"
azd env set CODEX_MODEL_NAME "gpt-5.2-codex"
azd up
```

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
    "model": "gpt-5.2-codex",
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
