# Architecture

## Runtime boundary

HaeronClaw is a Microsoft Foundry Hosted Agent with Codex app-server as its coding execution engine.

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
        └── Codex app-server
                ├── agent loop
                ├── shell / git / files
                └── /workspace
```

Foundry owns agent identity, authentication, lifecycle, scaling, isolation, and the external Responses API. Codex owns repository analysis, tool execution, file editing, and the coding-agent loop.

## Project structure

```text
azure.yaml                     # Foundry Hosted Agent deployment manifest
hosted-agent/
├── Dockerfile                 # Protocol 2.0 runtime image
├── main.py                    # Responses handler and stream adapter
└── codex_adapter/
    ├── client.py              # Codex stdio JSON-RPC client
    ├── config.py              # Runtime/model configuration
    ├── responses.py           # Responses event conversion
    └── session_map.py         # Response-to-thread persistence

webui/                         # Independent Next.js + React + AG-UI app
├── src/app/api/agent/route.ts # Server-side Foundry proxy
├── src/lib/agent-proxy.ts     # Validation and response helpers
└── Dockerfile                 # Generic OCI / Web App for Containers image

src/                           # Agent instructions, skills, tools, and knowledge
infra/ and teams-app/          # Legacy Azure Functions/ACA delivery path
```

## Session and streaming flow

1. The browser sends AG-UI messages only to the same-origin `/api/agent` route.
2. The route validates the configured endpoint and invokes the Foundry Responses API.
3. Foundry forwards the request to the hosted container on port `8088`.
4. The adapter starts or resumes a Codex thread and streams Codex turn events.
5. The adapter emits Responses events; the web proxy converts them into AG-UI events.
6. `previous_response_id` preserves the conversation-to-Codex-thread relationship.

The response map is stored under the hosted session workspace so session resume does not depend on process memory.

## Configuration and security

- Model endpoint, API key, and model name are runtime environment variables.
- The generated Codex configuration references the key environment variable; it never embeds the secret.
- Codex defaults to `workspace-write` with approval policy `never`.
- The Web UI key remains server-side when supplied through container settings.
- The Web UI only permits approved HTTPS endpoint suffixes in production.
- Foundry session isolation is the security boundary; the adapter does not implement a separate multi-tenant sandbox.

## Legacy runtime

The former Azure Functions on Azure Container Apps runtime remains under `infra/` for migration compatibility, including Teams, MCP, timers, and enterprise delivery integrations. It is not used by the primary Hosted Agent deployment in `azure.yaml`; migrate those integrations explicitly before retiring the legacy path.
