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

## Routine releases

After the first deployment, publish both the Hosted Agent and Web UI with:

```bash
python scripts/release-hosted-agent.py
```

The release command requires a clean committed worktree. It runs the skill,
Hosted Agent, and maturity MCP gates; validates the production Agent image
locally; builds immutable Agent and Web UI images in `haxureg`; creates a new
`haeronclaw-codex` version; exercises `maturity_get_question`; updates the
`haeronclaw-haxu` Web App; and waits for HTTP readiness. A non-secret receipt is
written under `.azure/releases/`.

For a faster release that skips only the local Docker validation:

```bash
python scripts/release-hosted-agent.py --fast
```

Use `--build-only` to publish both images without rolling them out, or
`--skip-webui` for an intentional Agent-only release. Resource names and
timeouts can be overridden; run `python scripts/release-hosted-agent.py --help`
for the complete interface. Failed Agent validation deletes only the version
created by that run. Failed Web UI readiness restores the previous Web App
image.

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
