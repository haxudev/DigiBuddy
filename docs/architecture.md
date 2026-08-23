# Architecture

## Runtime boundary

DigiBuddy is a Microsoft Foundry Hosted Agent with Codex app-server as its coding execution engine.

```text
Next.js / React Web UI
        │ AG-UI
        ▼
Next.js server proxy
        │ Responses protocol 2.0
        ▼
Microsoft Foundry Hosted Agent
        │
        ├── Responses adapter
        ├── response ↔ Codex thread mapping
        ├── profile assembly + config overlay
        └── Codex app-server
                ├── agent loop
                ├── shell / git / files
                └── /workspace
```

The Web UI also serves `/admin`, which writes the shared configuration store that the adapter reads at each turn boundary.

Foundry owns agent identity, authentication, lifecycle, scaling, isolation, and the external Responses API. Codex owns repository analysis, tool execution, file editing, and the coding-agent loop.

## Project structure

```text
azure.yaml                     # Foundry Hosted Agent deployment manifest
hosted-agent/
├── Dockerfile                 # Protocol 2.0 runtime image
├── main.py                    # Responses handler and stream adapter
└── codex_adapter/
    ├── client.py              # Codex stdio JSON-RPC client
    ├── config.py              # Runtime/model configuration and profile assembly
    ├── config_store.py        # Blob/file configuration overlay
    ├── profiles.py            # Agent profile parsing
    ├── responses.py           # Responses event conversion
    └── session_map.py         # Response-to-thread persistence

webui/                         # Independent Next.js + React + AG-UI app
├── src/app/api/agent/route.ts # Server-side Foundry proxy
├── src/app/api/admin/config/  # Admin configuration API
├── src/app/api/profiles/      # Public profile list for the chat picker
├── src/app/admin/             # Admin console
├── src/lib/admin-config.ts    # Configuration schema and store clients
├── src/lib/admin-auth.ts      # Easy Auth administrator guard
├── src/lib/agent-proxy.ts     # Validation and response helpers
└── Dockerfile                 # Generic OCI / Web App for Containers image

src/                           # Agent payload: persona, skills, tools, mcp.json
├── AGENTS.md                  # Persona and capability catalogue
├── mcp.json                   # Remote/local MCP server catalogue
├── skills/                    # <name>/SKILL.md definitions
└── tools/                     # Python tools with CLI entry points
```

The `src/` tree is copied into the image at `/opt/digibuddy` and surfaced to Codex through `DIGIBUDDY_PAYLOAD_ROOT`, `DIGIBUDDY_SKILLS_ROOT`, and `DIGIBUDDY_TOOLS_ROOT`.

## Session and streaming flow

1. The browser sends AG-UI messages only to the same-origin `/api/agent` route.
2. The route validates the configured endpoint and invokes the Foundry Responses API.
3. Foundry forwards the request to the hosted container on port `8088`.
4. The adapter starts or resumes a Codex thread and streams Codex turn events.
5. The adapter emits Responses events; the web proxy converts them into AG-UI events.
6. `previous_response_id` preserves the conversation-to-Codex-thread relationship.

The response map is stored under the hosted session workspace so session resume does not depend on process memory.

## Configuration and security

- Model endpoint, API key, and model name are runtime environment variables, optionally overlaid by `models.json` in the shared configuration store.
- The generated Codex configuration references the key environment variable; it never embeds the secret.
- Codex defaults to `workspace-write` with approval policy `never`.
- The Web UI key remains server-side when supplied through container settings.
- The Web UI only permits approved HTTPS endpoint suffixes in production.
- `/admin` is guarded by an Entra allowlist over the Easy Auth principal header; the model key is write-only and every write is audited.
- Foundry session isolation is the security boundary; the adapter does not implement a separate multi-tenant sandbox. Profile skill and tool filtering curates what an agent is offered, and is not itself a sandbox.

## Configuration overlay and profiles

`config_store.py` reads four documents — `models.json`, `mcp.json`, `profiles.json`, and `catalogue.json` — from Azure Blob (`DIGIBUDDY_CONFIG_URI`) or a directory (`DIGIBUDDY_CONFIG_DIR`), behind a short TTL cache.

At each turn boundary the adapter re-reads the overlay, resolves the requested profile from `metadata.profile`, and fingerprints the resulting model settings and profile. A changed fingerprint restarts the Codex engine, so administrative changes apply without a redeploy. A restricted profile gets a filtered view of the payload, with `DIGIBUDDY_SKILLS_ROOT` and `DIGIBUDDY_TOOLS_ROOT` pointed at it.

At startup the runtime publishes `catalogue.json`, describing the skills, tools, and MCP servers the image actually ships, so the admin console cannot drift from the deployed image.

## Agent payload

The Codex sandbox has no tool registry — only a shell. Capabilities are therefore delivered as files:

- **Persona**: `src/AGENTS.md` is concatenated with the hosted-agent guardrails in `hosted-agent/AGENTS.md` to form the Codex base instructions.
- **Tools**: each module under `src/tools/` exposes an `argparse` CLI and is invoked as `python -m <tool>`.
- **Skills**: each `src/skills/<name>/SKILL.md` is read on demand by the agent.
- **MCP**: `src/mcp.json` is rendered into `[mcp_servers.*]` blocks in the generated Codex `config.toml`.

