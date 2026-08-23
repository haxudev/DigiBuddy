# DigiBuddy Web UI

Standalone Next.js, React, and AG-UI client for the DigiBuddy Codex Hosted Agent.

## Local development

```bash
npm ci
npm run dev
```

Open `http://localhost:3000`. Configure the Responses endpoint, key, model, and optional Foundry agent reference in the settings panel, or set the variables listed in `environment.example`.

The browser speaks AG-UI only to `/api/agent`. The Next.js route validates the endpoint, keeps server-configured keys out of browser responses, invokes the Foundry Responses API, and translates its stream into AG-UI events.

## Admin console

`/admin` centrally manages the runtime: model access, remote MCP servers, and agent profiles that assemble skills and tools. Changes are written to a shared configuration store — Azure Blob (`DIGIBUDDY_CONFIG_URI`, Entra ID) or a directory (`DIGIBUDDY_CONFIG_DIR`) — that the hosted agent reads at each turn boundary, so no redeploy is needed.

The capability lists the console offers come from `catalogue.json`, published by the runtime at startup, so the console cannot offer a skill or tool the image does not ship.

Access is guarded by `requireAdmin`: put Easy Auth in front of the container and list the allowed Entra object IDs in `ADMIN_PRINCIPAL_IDS`. An empty list denies everyone. The model API key is write-only — it is never returned to the browser, and leaving the field blank preserves the stored value.

Chat users pick a profile in the settings panel; it travels to the agent as `metadata.profile`.

## Container

```bash
docker build -t digibuddy-webui .
docker run --rm -p 3000:3000 \
  -e FOUNDRY_AGENT_ENDPOINT=https://your-foundry-endpoint/responses \
  -e FOUNDRY_AGENT_API_KEY=replace-at-runtime \
  -e CODEX_MODEL_NAME=gpt-5.2-codex \
  digibuddy-webui
```

The image listens on port `3000` and uses Next.js standalone output. It can run on Azure Web App for Containers or any OCI-compatible container service.

For production, place secrets in the hosting platform configuration, leave the UI key field blank, and restrict `AGENT_ENDPOINT_ALLOWLIST` to approved endpoint suffixes.
