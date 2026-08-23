---
name: agent-maturity-deploy
description: Install the agent maturity assessment pack into an agent runtime and verify it loaded. Use when asked to install, deploy, register, wire up or set up the maturity assessment skills or its MCP server; to make the maturity tools available in Claude Code, Claude Desktop, GitHub Copilot CLI, VS Code, Cursor, Codex, LangGraph or another agent host; to fix a skill that is not being discovered; or to migrate an existing install after the skill directory was moved.
license: MIT
---

# Deploy the pack into an agent runtime

One MCP server plus four skills. The server is hand-rolled on the standard
library, so there is nothing to install before installing: any Python 3.9+ works
and no package manager is required.

## What ships

| Artifact | What consumes it |
| --- | --- |
| MCP server, `python -m agent_maturity.mcp` | Claude Code and Desktop, VS Code, Copilot CLI, Cursor, Codex, Zed - anything speaking MCP |
| `skills/*/SKILL.md` (agentskills.io) | Claude Code, Copilot CLI, VS Code, Cursor, Gemini CLI, Scout and other skill-aware hosts |
| `.claude-plugin/plugin.json` + `marketplace.json` | Claude Code plugin install |
| `.github/agents/agent-maturity.agent.md` | GitHub Copilot custom agent |
| `.vscode/mcp.json`, `.mcp.json`, `mcp.json` | Per-host MCP registration |
| `src/agent_maturity/adapters/langgraph.py` | LangGraph, via `interrupt()` |

Prefer the MCP server. It carries the 12 tools and the 5 reference resources, so
one registration covers every MCP host at once; the skills then tell the model
how to use them well.

## Install the skills

```bash
python tools/install.py --list                      # what is detected, what is installed
python tools/install.py --all --dry-run             # the plan, changing nothing
python tools/install.py --runtime claude,copilot    # install
python tools/install.py --runtime copilot --mcp     # and register the MCP server
```

Runtime keys and where they install:

| Key | Skills directory |
| --- | --- |
| `claude` | `~/.claude/skills` |
| `copilot` | `~/.copilot/skills` |
| `agents` | `~/.agents/skills` |
| `vscode` | `<workspace>/.github/skills` |
| `scout` | `~/.scout/m-skills` |

**`--mode copy` is the default and is what you usually want.** It vendors the
Python package into each installed skill's `_lib/`, so the skill keeps working
if the repository moves or disappears. `--mode link` uses a junction on Windows
or a symlink elsewhere and is for developing against the repository.

`--uninstall` removes them again; it refuses to delete a directory that does not
contain a `SKILL.md`, so a mistyped path cannot take out something else.

## Register the MCP server

`--mcp` merges into an existing config rather than overwriting it. To do it by
hand, the server command is always the same and only the wrapper differs.

**Claude Code / Claude Desktop** - `.mcp.json`:

```json
{ "mcpServers": { "agent-maturity": {
    "command": "python", "args": ["-m", "agent_maturity.mcp"],
    "env": { "PYTHONPATH": "/path/to/repo/src" } } } }
```

**VS Code** - `.vscode/mcp.json`. Note the key is `servers`, not `mcpServers`:

```json
{ "servers": { "agent-maturity": { "type": "stdio",
    "command": "python", "args": ["-m", "agent_maturity.mcp"],
    "cwd": "${workspaceFolder}",
    "env": { "PYTHONPATH": "${workspaceFolder}/src" } } } }
```

**GitHub Copilot CLI** - `~/.copilot/mcp-config.json`, same shape as Claude's.

If the package is pip-installed, drop `PYTHONPATH` and use the console script
`agent-maturity-mcp` as the command.

## Verify it actually loaded

Do not assume. Ask the host to list its tools and confirm all twelve
`maturity_*` names appear. Failing that, drive the server directly:

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | python -m agent_maturity.mcp
```

Two lines of JSON come back on stdout. The second lists the tools. Then confirm
the pipeline itself works, with no host involved:

```bash
agent-maturity check-bank
python -m unittest discover -s tests -v
```

## When a skill is not discovered

- **The directory name must equal the frontmatter `name`.** A mismatch is the
  most common cause and most hosts fail silently. `install.py` warns about it.
- Names must match `[a-z0-9-]` and be at most 64 characters; `description` must
  be at most 1024. An invalid character makes VS Code skip the skill without a
  message.
- Restart the host. Most read the skills directory once at startup.
- Check precedence: an enterprise or personal copy can shadow a project one.

## When the MCP server is not working

Symptoms map cleanly to causes, because stdout carries protocol frames and
nothing else:

- **Host reports a parse error or garbage** - something printed to stdout.
  Nothing in this package should; if you added code, log to stderr instead.
- **`maturity_run_interview` is missing from the tool list.** That is correct
  behaviour, not a fault: the tool is advertised only when the client declares
  the `elicitation` capability. Use `maturity_next_question` and
  `maturity_record_answer`, which work everywhere.
- **`ModuleNotFoundError: agent_maturity`** - `PYTHONPATH` is not pointing at
  the repository's `src` directory, or the package is not installed.

## Migrating from before 0.2

The skill used to live in a single `skill/` directory. It is now
`skills/agent-maturity-assess/`, alongside three companions. An existing
junction or symlink still pointing at the old path is broken:

```bash
python tools/install.py --repair-links
```

## Other runtimes

`docs/runtimes.md` has recipes for hosts without a bundled adapter: OpenAI
Agents SDK, Microsoft Agent Framework, Google ADK and Copilot Studio. The
general recipe is short, because the tool surface is protocol-independent:
`agent-maturity tools` prints all twelve tools as JSON Schema, and
`agent_maturity.toolkit.call(name, arguments)` invokes them from Python.
