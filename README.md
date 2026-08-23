# HaeronClaw

[English](README.md) | [简体中文](README.zh-CN.md)

> Codex coding runtime on Microsoft Foundry Hosted Agent.

HaeronClaw packages Codex app-server as the Coding Agent Runtime / Execution Engine inside Microsoft Foundry Hosted Agent. It exposes the Foundry Responses protocol `2.0.0` and includes an independent Next.js + React + AG-UI Web UI for container deployment.

The former Azure Functions on Azure Container Apps runtime is retained under `infra/` as a legacy migration path for Teams, MCP, timers, and enterprise delivery integrations.

**Core features**

- Deploy a protocol `2.0.0` agent through Microsoft Foundry
- Use Codex app-server for coding-agent loops, shell, Git, and file operations
- Resume Codex threads through persistent response/session mapping
- Configure model endpoint, key, and model name at runtime
- Connect through a standalone Next.js + React + AG-UI application
- Deploy the Web UI to Web App for Containers or any OCI-compatible host

## Advanced Features Added in This Project

- **Azure Blob artifact delivery**: generated files are uploaded to Azure Blob Storage and exposed through application-owned download links, so users can retrieve reports, decks, spreadsheets, and other outputs without SAS token handling.
- **Email workflows with Microsoft 365**: the `m365_cli` tool can send email, read mail, inspect calendars, browse OneDrive, and query SharePoint from the agent runtime.
- **Blob-backed email attachments**: binary email attachments are automatically staged to Blob Storage and rewritten as clean download links when direct attachment delivery is not appropriate.
- **Teams async execution**: long-running jobs are processed in the background with proactive replies, typing indicators, and heartbeat-style progress behavior.
- **Voice message transcription**: Teams audio attachments can be transcribed through Azure Speech so users can interact with HaeronClaw by voice.
- **SharePoint and OneDrive ingestion**: shared document links can be resolved through Microsoft Graph OBO flows for grounded document-aware responses.
- **Document and artifact generation**: the agent can produce deliverables such as PPTX, DOCX, XLSX, PDF, and other generated files, then deliver them through Teams, HTTP, or email-friendly links.
- **Knowledge-backed responses**: storage-backed `work_memory/`, `index_memory/`, and Microsoft Learn sources can be combined for source-grounded answers.

**Hosting your agent in Azure Functions**

Azure Functions is a serverless compute platform that already supports runtimes like JavaScript, Python, and .NET. An agent project with `AGENTS.md`, skills, and MCP servers is just another workload. This repository packages those pieces into an Azure-hosted runtime for cloud execution.

Development workflow:

1. Define and test your agent in VS Code as a standard Copilot project
2. Deploy the same project to Azure Functions on Azure Container Apps
3. Your agent is now a cloud-hosted HTTP API — no rewrites needed

This repo packages **HaeronClaw**, a Microsoft expert agent that helps developers, architects, and business users work with Azure pricing, documentation, internal knowledge, email workflows, SharePoint content, and generated deliverables.

## Project Structure

```
azure.yaml                    # Microsoft Foundry Hosted Agent manifest
hosted-agent/                 # Responses adapter and Codex execution runtime
webui/                        # Standalone Next.js + React + AG-UI application

src/                          # Agent definition, skills, tools, and work memory
├── AGENTS.md                 # HaeronClaw instructions, behavior, and optional function frontmatter
├── .github/skills/           # Markdown skills loaded by the runtime
├── .vscode/mcp.json          # MCP server configuration for local authoring/runtime parity
├── tools/
│   ├── cost_estimator.py     # Pricing math helpers
│   ├── create_eml.py         # EML generation helper
│   ├── fetch_url.py          # URL ingestion helper
│   └── m365_cli.py           # Mail, calendar, OneDrive, SharePoint operations
├── work_memory/              # Domain knowledge and internal FAQ content
└── index_memory/             # Indexed content for agent retrieval workflows

infra/assets/                 # Legacy Azure Functions + Teams runtime
├── function_app.py           # HTTP/function entrypoints
├── teams_bot.py              # Teams bot orchestration and proactive replies
├── file_upload.py            # Azure Blob upload and download-link pipeline
├── sharepoint_graph.py       # Graph-based SharePoint/OneDrive access
├── speech_service.py         # Azure Speech integration for audio transcription
├── scripts/                  # Install-time helpers for bundled runtime dependencies
└── vendor/m365-cli/          # Repository-owned overrides applied after npm install

teams-app/                    # Teams app manifests and sideload packages
```

The primary deployment is defined by `azure.yaml` and built from `hosted-agent/Dockerfile`. The `webui/` image is deployed separately and connects to the resulting Foundry Responses endpoint. The Azure Functions implementation under `infra/` is not part of the primary Hosted Agent deployment.

The repository intentionally does not track a full `node_modules/` tree. Instead, any required customizations to bundled third-party code are stored under `infra/assets/vendor/` and applied after `npm install` via `infra/assets/scripts/apply-m365-cli-patches.mjs`.

`AGENTS.md` supports optional YAML frontmatter. The frontmatter can be used to take your agent beyond HTTP or a chat interface by integrating with Azure Functions' event-driven programming model. For example, you can define timer-triggered functions that run on a [schedule](#timer-triggers-from-agentsmd-frontmatter) without needing to write any Azure Functions code.

## Running Locally in VS Code

1. Open the `src` folder in VS Code
2. Enable the experimental setting: `chat.useAgentSkills`
3. Enable built-in tools in Copilot Chat
4. Start chatting with your agent in Copilot Chat

Your agent's instructions from `AGENTS.md`, skills from `.github/skills/`, and MCP servers from `.vscode/mcp.json` are all automatically loaded.

## Deploying the Foundry Hosted Agent

### Deployment

Configure the model and deploy with Azure Developer CLI:

Use the unified entry point:

```bash
azd auth login
azd env set CODEX_MODEL_ENDPOINT "https://your-resource.openai.azure.com/openai/v1"
azd env set CODEX_MODEL_API_KEY "<model-key>"
azd env set CODEX_MODEL_NAME "gpt-5.2-codex"
azd up
```

Then deploy `webui/Dockerfile` to Web App for Containers or another OCI host and set `FOUNDRY_AGENT_ENDPOINT`. See [Quickstart](docs/quickstart.md) and [Architecture](docs/architecture.md).

## Legacy Azure Functions deployment

The sections below document the retained Azure Functions/ACA runtime. They do not configure the Foundry Hosted Agent.

### Authentication for GitHub Models

This project supports two auth modes when using `github:` models:

- **Recommended (Scheme B)**: pass a per-user GitHub OAuth token (`gho_`/`ghu_`) on each request. No long-lived app token is stored in Function App settings.
- **Backward compatibility**: provide `GITHUB_TOKEN` during deployment to use a shared service token.

In secure environments, prefer per-user OAuth tokens to reduce key leakage risk.

### Model Configuration Convention

This project is environment-variable driven at runtime.

- Use `COPILOT_MODEL` as the single runtime model setting.
- For GitHub Copilot models, always use the full model id, for example `github:gpt-5.4`.
- For Microsoft Foundry models, always use the full model id, for example `foundry:gpt-5.2-codex`.
- Do not introduce alias variables such as `GHCP_MODEL_NAME`; keeping a single runtime variable makes deployment and troubleshooting predictable.

Deployment inputs are normalized into `COPILOT_MODEL`:

- ACA path: the deployment scripts inject `COPILOT_MODEL` directly into the Container App.

### Deploy to ACA

From the terminal, run the deployment entry point:

```powershell
./scripts/deploy.ps1 -Mode aca -ResourceGroup <rg-name> -Location eastus2 -Prefix fmaaca -Model github:gpt-5.4 -ImageTag v3
```

Within minutes, you have a deployed agent behind an HTTP API and a built-in chat UI. The same source code that runs locally in Copilot Chat now runs remotely on Azure Functions on ACA.

The main inputs are:

| Prompt | Description |
|--------|-------------|
| **Resource Group** | Target Azure resource group |
| **Azure Location** | Azure region for deployment |
| **GitHub Token** | Optional shared service token. Leave empty to require per-request user OAuth tokens (`x-github-token` header). |
| **Model** | Which runtime model to use (see below) |
| **Image Tag** | Container image tag used for the ACA deployment |

#### Model Selection

You can choose from two categories of models:

- **GitHub models** (`github:` prefix) — Use the GitHub Copilot model API. No additional Azure infrastructure is deployed. Examples: `github:claude-sonnet-4.6`, `github:gpt-5.4`, `github:gpt-5.2`
- **Microsoft Foundry models** (`foundry:` prefix) — Deploys a Microsoft Foundry account and model in your subscription. Examples: `foundry:gpt-4.1-mini`, `foundry:claude-opus-4-6`, `foundry:o4-mini`

To change the model after initial deployment:

```powershell
./scripts/deploy.ps1 -Mode aca -ResourceGroup <rg-name> -Location eastus2 -Prefix fmaaca -Model github:gpt-5.4 -ImageTag <new-tag>
```

Redeploying with `-Model github:gpt-5.4` updates the app setting `COPILOT_MODEL` for you.

### Session Persistence

When running in Azure, agent sessions are automatically persisted to an Azure Files share mounted into the container app runtime. This means conversation state survives across restarts and is shared across instances, enabling multi-turn conversations with session resumption.

Locally, sessions are stored in `~/.copilot/session-state/`.

## Timer Triggers from `AGENTS.md` Frontmatter

You can define scheduled agent runs directly in `src/AGENTS.md` frontmatter using a `functions` array.

```yaml
---
functions:
  - name: timerAgent
    trigger: timer
    schedule: "0 */2 * * * *"
    prompt: "What's the price of a Standard_D4s_v5 VM in East US?"
    logger: true
---
```

Current behavior:

- Only `trigger: timer` is supported right now. Other trigger types are explicitly rejected at startup.
- `functions` section is optional.
- `schedule` and `prompt` are required for timer entries.
- `name` is optional (a safe unique name is generated if omitted).
- `logger` is optional and defaults to `true`.

When `logger: true`, the timer logs full agent output via `logging.info`, including:

- `session_id`
- final `response`
- `response_intermediate`
- `tool_calls`

Timer functions are registered at startup from frontmatter and run in the same runtime as `/agent/chat`.

## Building Custom Tools with Python

You can add custom tools by dropping plain Python files into `src/tools/`.

Example:

```python
from pydantic import BaseModel, Field


class CostEstimatorParams(BaseModel):
    unit_price: float = Field(description="Retail price per unit")
    unit_of_measure: str = Field(description="Unit of measure, e.g. '1 Hour'")
    quantity: float = Field(description="Monthly quantity")


async def cost_estimator(params: CostEstimatorParams) -> str:
    """Estimate monthly and annual costs from unit price and usage."""
    monthly_cost = params.unit_price * params.quantity
    annual_cost = monthly_cost * 12
    return f"Monthly: ${monthly_cost:.4f} | Annual: ${annual_cost:.4f}"
```

How tool discovery works:

- At runtime, the function app scans `tools/*.py` for tool definitions.
- It loads module-level functions defined in that module and filters out names that start with `_`.
- The function docstring becomes the tool description (fallback: `Tool: <function_name>` if no docstring).
- It registers only one function per file (the first function returned from discovery, which is name-sorted).
- If a tool module fails to import/load, the runtime logs the error and continues.

Guidelines:

- Keep tool functions focused and deterministic.
- Prefer a typed params model (for example, a Pydantic `BaseModel`) and pass it as the function argument.
- Use clear type hints and docstrings.
- Add any Python dependencies your tools need to `src/requirements.txt`.

Important: custom Python tools run in the cloud runtime (Azure Functions). They are not executed in local Copilot Chat.

## Bundled Dependency Patches

This repository patches selected `m365-cli` files used by the Azure runtime, but those patches are managed outside `node_modules`.

- Source-controlled overrides live under `infra/assets/vendor/m365-cli/`.
- `infra/assets/scripts/apply-m365-cli-patches.mjs` copies those files into `node_modules/m365-cli/` after install.
- `infra/assets/package.json` runs the patch step automatically through the `postinstall` script.

This keeps the repository open-source friendly while preserving the runtime behavior expected by the deployed container image.

## Using the Chat UI (Root Route)

After deployment, open your deployed app root URL:

```text
https://<your-app>.<environment>.<region>.azurecontainerapps.io/
```

The root route serves a built-in single-page chat UI.

At first load, enter:

- Base URL (typically your ACA app URL)
- GitHub OAuth user token (`gho_` / `ghu_`)

The base URL is stored in browser local storage. The GitHub token is stored in session storage only (cleared when the browser session ends).

You can also prefill both values via URL hash:

```text
https://<your-app>.<environment>.<region>.azurecontainerapps.io/#baseUrl=https%3A%2F%2F<your-app>.<environment>.<region>.azurecontainerapps.io&token=<url-encoded-gho-token>
```

On load, the page reads these values, stores base URL locally and token in session storage, then removes the hash from the address bar.

## Using MCP Server

The deployed app also exposes an MCP server endpoint:

```text
https://<your-app>.<environment>.<region>.azurecontainerapps.io/runtime/webhooks/mcp
```

If your environment enables function keys for the MCP extension endpoint, pass the key in the `x-functions-key` header.

### MCP Host Example

```bash
# Get the ACA host name
APP_NAME=<container-app-name>
RG=<resource-group>
HOST=$(az containerapp show --name "$APP_NAME" --resource-group "$RG" --query properties.configuration.ingress.fqdn -o tsv)
echo "https://$HOST/runtime/webhooks/mcp"
```

### Example VS Code `mcp.json` Configuration (Secure Key Prompt)

Use `inputs` with `password: true` so the MCP key isn't hardcoded in the file.

```json
{
  "inputs": [
    {
      "type": "promptString",
      "id": "functions-mcp-extension-system-key",
      "description": "Azure Functions MCP Extension System Key",
      "password": true
    },
    {
      "type": "promptString",
      "id": "functionapp-host",
      "description": "Container app host, e.g. fmaaca-xxxx.<env>.<region>.azurecontainerapps.io"
    }
  ],
  "servers": {
    "remote-mcp-function": {
      "type": "http",
      "url": "https://${input:functionapp-host}/runtime/webhooks/mcp",
      "headers": {
        "x-functions-key": "${input:functions-mcp-extension-system-key}"
      }
    }
  }
}
```

## Using the API

Once deployed, your agent is available as an HTTP API with two chat endpoints:

- `POST /agent/chat` for standard JSON responses
- `POST /agent/chatstream` for streaming Server-Sent Events (SSE)

### Basic Request

```bash
curl -X POST "https://<your-app>.<environment>.<region>.azurecontainerapps.io/agent/chat" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <gho_or_ghu_token>" \
  -H "x-github-token: <gho_or_ghu_token>" \
  -d '{"prompt": "What is the price of a Standard_D4s_v5 VM in East US?"}'
```

### Response

```json
{
  "session_id": "abc123-def456-...",
  "response": "The agent's final response text",
  "response_intermediate": "Any intermediate responses",
  "tool_calls": ["list of tools invoked during the response"]
}
```

The response always includes a `session_id` (also returned in the `x-ms-session-id` response header). Use this ID to continue the conversation.

### Multi-Turn Conversations

To resume an existing session, pass the session ID in the `x-ms-session-id` request header:

```bash
# Follow-up — resumes the same session with full conversation history
curl -X POST "https://<your-app>.<environment>.<region>.azurecontainerapps.io/agent/chat" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <gho_or_ghu_token>" \
  -H "x-github-token: <gho_or_ghu_token>" \
  -H "x-ms-session-id: abc123-def456-..." \
  -d '{"prompt": "If I run that VM 24/7 for a month, what would it cost?"}'
```

If you omit `x-ms-session-id`, a new session is created automatically and its ID is returned in the response. See `test/test.cloud.http` for more examples.

### Streaming Endpoint (SSE)

Use `POST /agent/chatstream` to receive responses incrementally as SSE events.

```bash
curl -N -X POST "https://<your-app>.<environment>.<region>.azurecontainerapps.io/agent/chatstream" \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -H "Authorization: Bearer <gho_or_ghu_token>" \
  -H "x-github-token: <gho_or_ghu_token>" \
  -d '{"prompt": "Give me a quick summary of Azure Functions pricing in 3 bullets."}'
```

To resume an existing session, pass `x-ms-session-id` the same way as `/agent/chat`.

Typical streamed event types include:

- `session` (contains `session_id`)
- `delta` (incremental text chunks)
- `intermediate` (intermediate reasoning/response snippets)
- `tool_start` / `tool_end` (tool execution lifecycle metadata)
- `message` (final full response)
- `done` (stream completion)

Example SSE payload sequence:

```text
data: {"type":"session","session_id":"..."}

data: {"type":"delta","content":"Hello"}

data: {"type":"tool_start","tool_name":"bash","tool_call_id":"..."}

data: {"type":"message","content":"Hello...final"}

data: {"type":"done"}
```

### Getting the URL

After deployment, get the container app hostname using the Azure CLI:

```bash
# Get the base URL
APP_NAME=<container-app-name>
RG=<resource-group>
HOST=$(az containerapp show --name "$APP_NAME" --resource-group "$RG" --query properties.configuration.ingress.fqdn -o tsv)
echo "https://$HOST"

```

Use this value to populate `@baseUrl` in `test/test.cloud.http`, and pass a GitHub OAuth token in `Authorization: Bearer ...`.

## Known Limitations

- **Python tools in `src/tools/` do not work locally** since they're not natively supported by Copilot. They are fully functional after deploying to ACA.
- **Windows is not supported.** The packaging hooks are shell scripts (`.sh`) and require macOS, Linux, or WSL.

## Try It

1. Clone this repo
2. Open `src` in VS Code and chat with the agent locally (MCP and skills work; Python tools require cloud deployment)
3. Explore the `src` folder to see the agent definition
4. Run `./scripts/deploy.ps1 -Mode aca ...` to deploy to Azure Functions on ACA
5. Open your cloud-hosted chat UI at `/`
6. Optionally call `/agent/chat` (JSON) or `/agent/chatstream` (SSE) directly (see `test/test.cloud.http` for examples)
