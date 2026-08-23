# API Reference

## Overview

DigiBuddy exposes two surfaces:

- The **Hosted Agent** speaks the Microsoft Foundry **Responses protocol `2.0.0`**. This is the upstream API, callable directly by any Responses-compatible client.
- The **Web UI** exposes a single **AG-UI** SSE endpoint at `POST /api/agent`, which proxies to the Hosted Agent server-side so credentials never reach the browser.

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
| `FOUNDRY_AGENT_VERSION` | Agent version, defaults to `1` |
| `CODEX_MODEL_NAME` | Model name sent as `model` |
| `AGENT_ENDPOINT_ALLOWLIST` | Extra comma-separated host suffixes accepted as endpoints |

Every endpoint must be HTTPS and must match `services.ai.azure.com`, `openai.azure.com`, or a host listed in `AGENT_ENDPOINT_ALLOWLIST`. Outside production, `localhost` and `127.0.0.1` are also permitted.
