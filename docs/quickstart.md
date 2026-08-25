# Quickstart

## Prerequisites

- Azure Developer CLI with the `azure.ai.agents` extension
- Docker for local image validation
- Git credentials with read access to the repositories in `hosted-agent/skill-sources.lock`
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
release, Hosted Agent, maturity MCP, and Web UI test/lint/build gates; validates
the production Agent image locally; builds immutable Agent and Web UI images in
`haxureg`; creates a new `haeronclaw-codex` version; exercises
`maturity_get_question`; updates the `haeronclaw-haxu` Web App image and
`FOUNDRY_AGENT_VERSION`; then verifies both HTTP readiness and a complete Agent
response through the Web UI proxy. A non-secret receipt is written under
`.azure/releases/`.

For a faster release that skips only the local Docker validation:

```bash
python scripts/release-hosted-agent.py --fast
```

Use `--build-only` to publish both images without rolling them out, or
`--skip-webui` for an intentional Agent-only release. Resource names and
timeouts can be overridden; run `python scripts/release-hosted-agent.py --help`
for the complete interface. Failed Agent validation deletes only the version
created by that run. Failed Web UI validation restores the previous Web App
image and Agent version setting.

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

Point the Web UI and the Hosted Agent at the same configuration store, then configure either dedicated administrator credentials or an Entra allowlist:

```bash
azd env set DIGIBUDDY_CONFIG_URI "https://yourstorage.blob.core.windows.net/digibuddy-config"
```

```bash
docker run --rm -p 3000:3000 \
  -e FOUNDRY_AGENT_ENDPOINT="https://your-foundry-endpoint/responses" \
  -e DIGIBUDDY_CONFIG_URI="https://yourstorage.blob.core.windows.net/digibuddy-config" \
  -e ADMIN_USERNAME="admin" \
  -e 'ADMIN_PASSWORD_HASH=scrypt$16384$8$1$<base64url-salt>$<base64url-derived-key>' \
  -e ADMIN_SESSION_SECRET="<at-least-32-random-characters>" \
  digibuddy-webui
```

Both containers use the store with their managed identity, so grant each the **Storage Blob Data Contributor** role on the container. The hosted agent writes generated files below `artifacts/`, and the Web UI reads them back through its same-origin API. Configure a storage lifecycle rule for that prefix when deliverables need a retention limit. For local development set `DIGIBUDDY_CONFIG_DIR` to a shared directory and `ADMIN_ALLOW_ANONYMOUS=true` instead; the anonymous opt-in is ignored when `NODE_ENV=production`.

::: warning
Store only the scrypt hash in `ADMIN_PASSWORD_HASH`, never the plaintext password. If dedicated credentials are omitted, put Easy Auth in front of the Web UI and set `ADMIN_PRINCIPAL_IDS`; without either mode no production caller is admitted.
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

## Rolling out the agent plane

Per-profile credentials and capability packs each span two images — the hosted
agent and the Web UI — which are released independently. Both therefore ship
behind a kill switch, default off, so a half-rolled deployment is inert rather
than inconsistent.

```bash
# 1. Release the runtime that can read the new documents but does not act on them.
python scripts/release-hosted-agent.py

# 2. Confirm the agent still answers, then enable one feature at a time.
az containerapp update --name <agent> --set-env-vars DIGIBUDDY_ENABLE_PROFILE_CREDENTIALS=true
az containerapp update --name <agent> --set-env-vars DIGIBUDDY_ENABLE_CAPABILITY_PACKS=true
```

Order matters in one direction only: the runtime must be able to *read* a
document before the console starts writing it. Enabling a flag before the
matching console change is harmless, because nothing writes the document yet.

**Rolling back** is turning the flags off. The previous registry revision and
every superseded artifact are retained rather than deleted, so the prior state
is still there to return to. A release also drops environment variables the
runtime no longer reads — the Graph client secret moved into the per-profile
credential document — so a retired secret does not travel into new versions.

Verify after each step:

```bash
curl -fsS "$AGENT_ENDPOINT/readiness"
python3 scripts/probe_runtime_isolation.py   # run as an agent turn, not locally
```
