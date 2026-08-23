---
layout: home

hero:
  name: HaeronClaw
  text: Codex runtime on Microsoft Foundry Hosted Agent
  tagline: A coding agent with a Responses 2.0 adapter and a containerized Next.js + React + AG-UI client.
  actions:
    - theme: brand
      text: Quickstart
      link: /quickstart
    - theme: alt
      text: GitHub
      link: https://github.com/haxudev/haeronclaw

features:
  - title: Foundry Hosted Agent
    details: Deploy a Responses protocol 2.0 container with Foundry-managed identity, lifecycle, scaling, and session isolation.
  - title: Codex execution engine
    details: Run repository analysis, shell commands, Git operations, tests, and file edits through Codex app-server.
  - title: AG-UI web client
    details: Use an independent Next.js and React client that securely proxies Foundry Responses streams into AG-UI events.
  - title: Portable containers
    details: Deploy the Hosted Agent through Foundry and the Web UI to Web App for Containers or any OCI-compatible service.
---

## Product Overview

HaeronClaw packages Codex app-server as the Coding Agent Runtime inside Microsoft Foundry Hosted Agent. Foundry owns the service boundary while Codex owns software-engineering execution.

::: tip Why this project exists
Deploy the coding runtime with `azure.yaml`, then connect the standalone `webui/` container to its Foundry Responses endpoint.
:::

## Core Capabilities

- Responses protocol `2.0.0` Hosted Agent
- Codex app-server JSON-RPC lifecycle and streaming
- Persistent response-to-Codex-thread mapping
- Configurable model endpoint, key, and deployment name
- Next.js + React + AG-UI client
- Generic container deployment for the Web UI

## Development Workflow

1. Configure the Codex-compatible model with deployment environment variables.
2. Deploy the Hosted Agent using `azd up`.
3. Configure and deploy the independent Web UI container.

The earlier Azure Functions/ACA runtime remains under `infra/` as a migration path for Teams, MCP, timer, and enterprise delivery integrations.

## Next Steps

- Start with [Quickstart](/quickstart)
- Review [Features](/features)
- Integrate against the [API Reference](/api)
- Understand the [Architecture](/architecture)
