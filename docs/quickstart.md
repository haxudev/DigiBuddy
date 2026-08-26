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
azd env set CODEX_MODEL_NAME "gpt-5.6-sol"
azd env set CODEX_REASONING_EFFORT "medium"
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
  -e CODEX_MODEL_NAME="gpt-5.6-sol" \
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
The role assignment is necessary but not sufficient: the storage account's **network** must also admit both callers. RBAC and reachability fail differently and are easy to confuse, so check both. See [When the configuration store is unreachable](#when-the-configuration-store-is-unreachable).
:::

::: warning
Store only the scrypt hash in `ADMIN_PASSWORD_HASH`, never the plaintext password. If dedicated credentials are omitted, put Easy Auth in front of the Web UI and set `ADMIN_PRINCIPAL_IDS`; without either mode no production caller is admitted.
:::

Open `http://localhost:3000/admin` to manage models, remote MCP servers, and agent profiles. Changes apply at the next turn.

## When the configuration store is unreachable

Two symptoms point at the same cause, because both surfaces are built on the shared store:

- Typing `/` in the composer opens a menu that says the skill catalogue could not be loaded. The runtime publishes `catalogue.json`, so a store the Web UI cannot read leaves it with no skills to offer.
- Every reply reports that generated files could not be saved to the delivery area. The hosted agent writes deliverables below `artifacts/` in the same container.

Check reachability before checking permissions, because a blocked network and a missing role both surface as a failed request:

```bash
# Is the data plane open at all? `Disabled` means private endpoints only,
# whatever `networkAcls` says -- the public endpoint does not exist, so
# trusted-service bypass and resource instance rules do not apply either.
az storage account show -n <account> -g <group> --query publicNetworkAccess -o tsv

# Can this caller actually read the container?
az storage blob list --account-name <account> --container-name <container> \
  --auth-mode login -o table

# Do both identities hold the data role?
az role assignment list --scope <storage-account-resource-id> \
  --include-inherited --query "[?roleDefinitionName=='Storage Blob Data Contributor'].principalId" -o tsv
```

Where corporate policy pins `publicNetworkAccess` to `Disabled` — a `Modify`-effect assignment silently reverts an attempt to enable it, so the `az storage account update` call appears to succeed — the supported answer is a private endpoint for the blob subresource, a `privatelink.blob.core.windows.net` zone linked to that virtual network, and callers that sit inside it.

How the Web UI joins that network is worth choosing deliberately. App Service regional virtual network integration can be added to, moved between, or removed from an existing app at any time, and by default routes only application traffic, so the app reaches the private endpoint while its ordinary outbound path to the agent endpoint is untouched. A Container Apps environment fixes its network type at creation, so the same change means recreating the environment and every app in it. That is why this repository targets Web App for Containers.

Weigh the runtime side separately, because putting the *agent* inside a virtual network is far more expensive than it first appears:

- Network injection for a hosted agent can only be set when the Foundry account is created, and it obliges the whole Standard Agent Setup — bring-your-own Cosmos DB, AI Search, Storage and Key Vault. There is no inject-only path.
- An injected agent subnet has **no public egress by design**; the documentation lists "no public egress" as a feature. An agent that reaches remote MCP servers, documentation sites or a public model endpoint needs a NAT gateway or a firewall with FQDN allow-listing added back.
- Recreating the Foundry account starts agent versions and conversation history from empty. There is no migration path, and this runtime resumes Codex threads from `previous_response_id`.

Note also how much of the store the runtime needs, before assuming only file delivery is at stake. The hosted agent **writes** `catalogue.json`, which is the document the `/` menu is built from, and **reads** `models.json`, `profiles.json`, `mcp.json`, `credentials.json`, `skills.json`, `skill-policy.json` and every uploaded skill bundle. Routing generated files around the store therefore fixes delivery and nothing else: the skill menu stays empty and the admin console stops reaching the runtime. Any topology has to leave the agent itself a path to the container — either inside the network, or through a caller that is.

Neither symptom is fatal. The composer still sends messages, `@` still selects an agent, attachments still work, and the answer itself is unaffected: only skills and file delivery depend on the store.

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
