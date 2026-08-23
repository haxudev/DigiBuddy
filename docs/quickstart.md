# Quickstart

## Prerequisites

- Azure Developer CLI with the `azure.ai.agents` extension
- Docker for local image validation
- A model endpoint, key, and model deployment name compatible with Codex

## Deploy the Hosted Agent

```bash
azd auth login
azd env set CODEX_MODEL_ENDPOINT "https://your-resource.openai.azure.com/openai/v1"
azd env set CODEX_MODEL_API_KEY "<model-key>"
azd env set CODEX_MODEL_NAME "gpt-5.2-codex"
azd up
```

`azure.yaml` builds `hosted-agent/Dockerfile` remotely and registers a Foundry Hosted Agent using Responses protocol `2.0.0`. The runtime exposes `GET /readiness` and `POST /responses` on port `8088`.

::: warning
Store production keys in the deployment platform's secret configuration. Do not commit populated environment files.
:::

## Run the Web UI

```bash
cd webui
cp environment.example .env.local
npm ci
npm run dev
```

Open `http://localhost:3000`, then configure the Foundry Responses endpoint, authentication, agent reference, and model in the connection panel. Settings may instead be supplied through server environment variables.

## Deploy the Web UI container

```bash
cd webui
docker build -t haeronclaw-webui .
docker run --rm -p 3000:3000 \
  -e FOUNDRY_AGENT_ENDPOINT="https://your-foundry-endpoint/responses" \
  -e FOUNDRY_AGENT_API_KEY="<agent-key>" \
  -e CODEX_MODEL_NAME="gpt-5.2-codex" \
  haeronclaw-webui
```

The image listens on port `3000` and uses Next.js standalone output. Deploy it to Azure Web App for Containers or another OCI-compatible service. In production, restrict `AGENT_ENDPOINT_ALLOWLIST` to approved endpoint suffixes.

## Local checks

```bash
python -m unittest discover -s hosted-agent/tests -v
cd webui
npm test
npm run lint
npm run build
```

## Legacy Azure Functions path

The previous Azure Functions/ACA implementation remains available for migration scenarios:

```powershell
./scripts/deploy.ps1 -Mode aca -ResourceGroup <rg-name> -Location eastus2 -Prefix fmaaca -Model github:gpt-5.4 -ImageTag v3
```

This deploys the legacy APIs, Teams integration, MCP endpoint, and timer features. It is separate from the Hosted Agent deployment above.
