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
docker build -t digibuddy-webui .
docker run --rm -p 3000:3000 \
  -e FOUNDRY_AGENT_ENDPOINT="https://your-foundry-endpoint/responses" \
  -e FOUNDRY_AGENT_API_KEY="<agent-key>" \
  -e CODEX_MODEL_NAME="gpt-5.2-codex" \
  digibuddy-webui
```

The image listens on port `3000` and uses Next.js standalone output. Deploy it to Azure Web App for Containers or another OCI-compatible service. In production, restrict `AGENT_ENDPOINT_ALLOWLIST` to approved endpoint suffixes.

## Enable the admin console

Point the Web UI and the Hosted Agent at the same configuration store, then allowlist the administrators:

```bash
azd env set DIGIBUDDY_CONFIG_URI "https://yourstorage.blob.core.windows.net/digibuddy-config"
```

```bash
docker run --rm -p 3000:3000 \
  -e FOUNDRY_AGENT_ENDPOINT="https://your-foundry-endpoint/responses" \
  -e DIGIBUDDY_CONFIG_URI="https://yourstorage.blob.core.windows.net/digibuddy-config" \
  -e ADMIN_PRINCIPAL_IDS="<entra-object-id>,<entra-object-id>" \
  digibuddy-webui
```

Both containers read the store with their managed identity, so grant each the **Storage Blob Data Contributor** role on the container. For local development set `DIGIBUDDY_CONFIG_DIR` to a directory and `ADMIN_ALLOW_ANONYMOUS=true` instead; the anonymous opt-in is ignored when `NODE_ENV=production`.

::: warning
Put Easy Auth in front of the Web UI container. `ADMIN_PRINCIPAL_IDS` is matched against the `x-ms-client-principal` header, so without an authentication front end no caller is ever admitted.
:::

Open `http://localhost:3000/admin` to manage models, remote MCP servers, and agent profiles. Changes apply at the next turn.

## Local checks

```bash
cd hosted-agent && python -m unittest discover -s tests -t . -v
cd ../webui
npm test
npm run lint
npm run build
```
