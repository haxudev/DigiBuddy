# Probe recipes

Read-only commands for finding out what this machine can actually do. Nothing here writes, installs, or authenticates.

The ordering principle: **the cheapest source is your own context, and it is free.** Everything below is for what you genuinely cannot see from where you are sitting.

---

## T0 — Introspection. Preflight owns it. Usually free.

No commands. Read what you already have:

| What | Where it already is |
| --- | --- |
| Installed skills, with descriptions | Your skill tool's listing |
| Available tools, including MCP-provided ones | Your own tool list |
| Whether you can ask with a selection card | Your own tool list — anything taking a question plus enumerated options |
| Subagents you can delegate to | Your task/subagent tool's type list |
| Project rules already in force | Instruction files already loaded into your context |
| Domain profiles available | The file names in the project's, the user's, and the pack's profile directories — names only, not content |

On a typical developer machine this is dozens of skills and tools, known for free. An agent that shell-scans a skills directory to learn its own skill list has spent a turn to obtain something it was already given.

Harnesses differ, though. If yours does not expose one of these lists, probe for it rather than concluding it is empty — an unexposed list is unknown, not absent.

Keep T0 findings in this session's own context. Then stop unless the task needs more.

T0 runs in preflight, before the first clarifying question, because a question that offers what this machine cannot deliver costs an approval round to undo. It writes nothing: the lists are re-read every session and outrank anything a file remembers, so a cached copy would only be a copy nobody is allowed to trust. By the time this phase starts, preflight has already established them; use what it read rather than repeating the enumeration.

---

## T1 — Targeted probe. Only what the brief requires.

Derive the needed capabilities from the brief, then probe **only** those. Do not enumerate the machine.

### Command-line tools

One command, sub-second, covers a whole class. Probe the handful the task needs, not this entire list.

```bash
# POSIX
for c in git gh jq rg python3 uv node pandoc ffmpeg az aws gcloud kubectl terraform docker; do
  command -v "$c" >/dev/null 2>&1 && echo "$c yes" || echo "$c -"
done
```

```powershell
# Windows PowerShell
foreach ($c in 'git','gh','jq','rg','python','uv','node','pandoc','ffmpeg','az','aws','gcloud','kubectl','terraform','docker') {
  '{0,-12} {1}' -f $c, $(if (Get-Command $c -ErrorAction SilentlyContinue) { 'yes' } else { '-' })
}
```

Presence is not readiness. A cloud CLI that is installed but not logged in will fail at the step that needs it, not at the probe. Where a step depends on authentication, check it with a read-only call (an account or identity lookup) rather than assuming.

### MCP servers and agent configuration

Config location varies by harness, and several harnesses often coexist on one machine. Check for existence before reading; absence is a normal answer.

| Harness | Configuration |
| --- | --- |
| OpenCode | `~/.config/opencode/opencode.json`, project `opencode.json` |
| Claude Code | `~/.claude.json`, `~/.claude/settings.json`, project `.mcp.json` |
| Codex | `~/.codex/config.toml` |
| GitHub Copilot CLI | `~/.copilot/config.json`, `~/.copilot/mcp-config.json` |
| Others | `~/.gemini/`, `~/.cursor/` |

Prefer your own tool list over these files. If an MCP server's tools are in your context, it is running — which is what matters. The config only tells you what was declared.

Which harness you are in also decides how you can ask the user a question, because every host names its selection card differently and some have none. Never conclude from a config file that a card is unavailable; the tool list is what settles it.

### Project scaffolding

This is the part most surveys skip, and it changes plan quality more than the tool list does. A plan that invents its own commands when the project already has sanctioned ones will be rejected by whoever maintains it.

| Look for | Tells you |
| --- | --- |
| `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, `.github/copilot-instructions.md` | House rules already in force |
| `package.json` scripts, `Makefile`, `justfile`, `Taskfile.yml` | The sanctioned way to run things |
| `.github/workflows/`, other CI config | What this project means by "done" |
| `docs/`, `adr/`, `templates/`, prior reports | Expected output shape and house style |
| `.superclarity/` | Earlier work, possibly unfinished |

Reuse what is there. Inventing a parallel convention is a defect even when the new one is better.

---

## T2 — Deep probe. On demand only.

Triggered by a step failing, or by needing certainty before an expensive commitment.

- Load a candidate skill's own instructions before routing work through it. A description tells you what a skill claims to do; only the body tells you how it behaves and what it needs.
- Check authentication for the specific service the failing step touched.
- Read the specific config section, not the whole file.
- Verify a version when behaviour depends on it.

Then update both `environment.md` and the task's `capabilities.md`, so the next task does not repeat the discovery.

---

## Cost discipline

| Layer | Budget |
| --- | --- |
| T0 | Free. Always. |
| T1 | One or two tool calls. Probe what the brief needs; nothing else. |
| T2 | Only after a failure or before an expensive commitment. |

Show the user a capability finding **only when it changes the plan** — a specialist skill being routed to, or a gap needing a decision. A recital of everything installed is noise, and noise is why people turn skills off.

## Caching

Write what a probe taught you to `.superclarity/environment.md` with a
`surveyed_at` timestamp and the context the survey belongs to: operating system,
harness, and — where it matters — the account or tenant a provider was confirmed
against. The same workspace opened through a container, a remote agent, or a
different harness is a different machine, and a cache without that stamp will
hand back providers that are not there.

The file holds T1 readiness and nothing else. Preflight writes nothing: its T0
list is re-read every session and is authoritative over anything a file
remembers, so caching it would only create a copy nobody is allowed to trust. A
task that probes nothing therefore never creates this file.

Re-survey when:

- the file is older than about seven days, or
- the recorded context does not match the current one, or
- a step fails for a missing or unauthenticated tool, or
- the user says the environment changed.

Otherwise read the cache. Repeat tasks in the same workspace and the same context should cost nothing to survey.

Always re-run T0 in preflight regardless of cache: your own tool and skill list is per-session, free, and authoritative over anything a file remembers.
