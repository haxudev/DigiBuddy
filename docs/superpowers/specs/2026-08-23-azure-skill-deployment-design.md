# Azure Skill Deployment Design

## Goal

Package `haxudev/superclarity` and `haxudev/agent-maturity-assessment`
into the DigiBuddy Hosted Agent image so every Azure deployment is
reproducible, starts without fetching code, uses Superclarity as the default
workflow entry, and exposes the Agent Maturity MCP tools through Codex.

## Chosen Approach

Vendor immutable snapshots of both repositories into the Docker build context.
A manifest records repository URLs and exact commits. A sync command refreshes
the snapshots deliberately and writes provenance; Azure builds consume only
the checked-in snapshot and never clone or install packages at runtime.

This is preferred over build-time or runtime fetching because it is
self-contained, reviewable, and insensitive to GitHub availability or upstream
branch movement.

## Package Layout

- `hosted-agent/skills/` contains all seven Superclarity skills and all four
  Agent Maturity skills, including their references, templates, and scripts.
- `hosted-agent/vendor/agent-maturity/` contains the zero-dependency
  `agent_maturity` Python package used by the local MCP server.
- A provenance manifest records each upstream repository, ref, and resolved
  commit.
- The container copies these artifacts into fixed image paths. No runtime
  `git clone`, `pip install`, or package-manager lookup is required.

Superclarity scripts require Node.js 20.10 or newer. The image must provide a
pinned supported Node.js runtime and fail its build if that requirement is not
met.

## Default Routing

The Hosted Agent base instructions make `superclarity` the first skill for
multi-step, long-running, ambiguous, or consequential work. Explicitly simple
requests can proceed directly. This follows Superclarity's documented default
entry mechanism; Codex does not provide a separate default-skill setting.

All seven Superclarity skills must be installed together. Partial installation
is a build error.

## Agent Maturity MCP

`src/mcp.json` registers an `agent-maturity` stdio server:

- command: `python`
- module: `agent_maturity.mcp`
- `PYTHONPATH`: the fixed image path containing the vendored package

The existing config renderer carries command, arguments, and environment into
Codex `config.toml`. The default DigiBuddy profile allows the server because an
unrestricted profile includes every packaged MCP server.

## Failure Handling

The sync command fails for missing repositories, unresolved commits, duplicate
skill names, missing `SKILL.md` files, incomplete Superclarity installation, or
missing Agent Maturity package files. Docker builds fail when staged artifacts
or the required Node.js version are absent. MCP startup errors remain visible
to Codex rather than being silently ignored.

## Verification

Automated checks must prove:

1. Eleven expected skills and their support assets are packaged.
2. Provenance contains immutable commit SHAs for both sources.
3. Agent Maturity imports without installed third-party dependencies.
4. The MCP server completes `initialize` and `tools/list`, exposing 11 tools
   without elicitation and 12 when elicitation is declared.
5. Rendered Codex configuration includes the local stdio server and fixed
   `PYTHONPATH`.
6. Superclarity is present in the generated skill catalogue and the default
   routing instruction is included.
7. The Hosted Agent image builds with Node.js 20.10 or newer.

No Azure resource deployment is required to validate packaging; the same
Dockerfile and startup path used by `azd` are exercised locally.
