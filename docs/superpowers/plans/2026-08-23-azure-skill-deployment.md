# Azure Skill Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship pinned, self-contained Superclarity and Agent Maturity skills in the DigiBuddy Azure Hosted Agent image, make Superclarity the default workflow entry, and load the Agent Maturity stdio MCP server.

**Architecture:** A lock file pins both upstream repositories to immutable commits, and the existing sync command materializes complete snapshots into tracked Docker build-context directories. The image includes a pinned Node.js runtime, copies the Agent Maturity Python package without installing dependencies, publishes all skills into `CODEX_HOME`, and renders a fixed-path local MCP registration.

**Tech Stack:** Bash, Git, Docker multi-stage builds, Python 3.12 standard library, Node.js 22, Codex TOML configuration, MCP JSON-RPC over stdio.

## Global Constraints

- Azure startup must not clone repositories, run `pip install`, or depend on GitHub availability.
- Package all seven Superclarity skills and all four Agent Maturity skills.
- Superclarity requires Node.js 20.10 or newer.
- Agent Maturity must retain its zero-third-party-dependency MCP implementation.
- Every source snapshot must record an immutable 40-character commit SHA.
- Superclarity is the first workflow for multi-step, long-running, ambiguous, or consequential tasks.
- The Agent Maturity MCP server must expose 11 tools without elicitation and 12 when elicitation is declared.

---

### Task 1: Deterministic Skill Snapshot

**Files:**
- Create: `hosted-agent/skill-sources.lock`
- Modify: `.gitignore`
- Modify: `scripts/sync-agent-skills.sh`
- Create: `hosted-agent/skills/**`
- Create: `hosted-agent/vendor/agent-maturity/agent_maturity/**`
- Create: `hosted-agent/vendor/PROVENANCE.txt`
- Test: `hosted-agent/tests/test_skill_bundle.py`

**Interfaces:**
- Consumes: Git repositories containing `skills/*/SKILL.md`; Agent Maturity also provides `src/agent_maturity`.
- Produces: `scripts/sync-agent-skills.sh [--check]`; a complete tracked bundle under `hosted-agent/skills`; importable package root `hosted-agent/vendor/agent-maturity`.

- [ ] **Step 1: Write failing bundle tests**

Add tests that parse `hosted-agent/skill-sources.lock`, require exact expected
skill names, require support assets such as Superclarity scripts and Agent
Maturity references, verify both provenance SHAs are 40 lowercase hex
characters, and import `agent_maturity.mcp` with only the vendored package root
on `PYTHONPATH`.

- [ ] **Step 2: Run the tests to verify failure**

Run: `python -m unittest hosted-agent/tests/test_skill_bundle.py -v`

Expected: FAIL because the lock file and bundled package do not yet exist.

- [ ] **Step 3: Implement deterministic synchronization**

Use this lock-file schema:

```text
superclarity haxudev/superclarity <40-character-commit>
agent-maturity haxudev/agent-maturity-assessment <40-character-commit>
```

The script must shallow-fetch each exact commit, reject malformed lock rows,
copy all skill directories while rejecting duplicate names, copy the complete
`agent_maturity` package, retain upstream licenses, write provenance, and
support `--check` by syncing into a temporary directory and comparing it with
the tracked bundle.

- [ ] **Step 4: Materialize the pinned snapshots**

Run: `scripts/sync-agent-skills.sh`

Expected: exactly 11 skill directories, an Agent Maturity Python package, and
provenance for both resolved commits.

- [ ] **Step 5: Run bundle tests and drift check**

Run:

```bash
python -m unittest hosted-agent/tests/test_skill_bundle.py -v
scripts/sync-agent-skills.sh --check
```

Expected: PASS and `Skill bundle matches locked sources`.

- [ ] **Step 6: Commit**

```bash
git add .gitignore scripts/sync-agent-skills.sh hosted-agent/skill-sources.lock \
  hosted-agent/skills hosted-agent/vendor hosted-agent/tests/test_skill_bundle.py
git commit -m "build: vendor Azure agent skill bundle"
```

### Task 2: Runtime, Default Routing, and MCP Wiring

**Files:**
- Modify: `hosted-agent/Dockerfile`
- Modify: `hosted-agent/AGENTS.md`
- Modify: `hosted-agent/codex_adapter/config.py`
- Modify: `hosted-agent/tests/test_config.py`
- Modify: `src/mcp.json`
- Modify: `README.md`

**Interfaces:**
- Consumes: Task 1 package root `/app/hosted-agent/vendor/agent-maturity` and skill root `/app/hosted-agent/skills`.
- Produces: Node.js 22 runtime; default Superclarity instruction; rendered `[mcp_servers.agent-maturity]`; catalogue containing global and payload skills.

- [ ] **Step 1: Write failing runtime tests**

Extend config tests to assert:

```python
server = load_mcp_servers(settings_with_packaged_mcp)
assert server["agent-maturity"]["command"] == "python"
assert server["agent-maturity"]["args"] == ["-m", "agent_maturity.mcp"]
assert server["agent-maturity"]["env"]["PYTHONPATH"] == "/app/hosted-agent/vendor/agent-maturity"
assert "superclarity" in build_catalogue(settings_with_global_skills).skills
```

Also assert the Hosted Agent instructions contain the mandatory Superclarity
default-routing sentence.

- [ ] **Step 2: Run targeted tests to verify failure**

Run: `cd hosted-agent && python -m unittest tests.test_config -v`

Expected: FAIL because the MCP entry and merged global catalogue are absent.

- [ ] **Step 3: Wire runtime artifacts**

Use `node:22.14.0-bookworm-slim` as a Docker build stage, copy its Node binary
and npm modules into `python:3.12-slim`, and assert `node` is at least 20.10.
Keep all skill and vendor assets inside `/app/hosted-agent`.

Add `agent-maturity` to `src/mcp.json` with a stdio command and fixed
`PYTHONPATH`. Extend catalogue construction to union payload skills with
`settings.skills_source`. Replace the weak default instruction with the
documented Superclarity first-routing rule.

- [ ] **Step 4: Run targeted tests**

Run:

```bash
cd hosted-agent
python -m unittest tests.test_config tests.test_profiles -v
```

Expected: PASS.

- [ ] **Step 5: Document operations**

Document the pinned bundle refresh command, drift check, default routing, local
MCP registration, and the fact that Azure startup is network-independent.

- [ ] **Step 6: Commit**

```bash
git add hosted-agent/Dockerfile hosted-agent/AGENTS.md \
  hosted-agent/codex_adapter/config.py hosted-agent/tests/test_config.py \
  src/mcp.json README.md
git commit -m "feat: load bundled Azure skills and maturity MCP"
```

### Task 3: End-to-End Azure Artifact Verification

**Files:**
- Create: `hosted-agent/tests/probe_maturity_mcp.py`
- Modify: `hosted-agent/tests/test_skill_bundle.py`

**Interfaces:**
- Consumes: completed image packaging and MCP registration.
- Produces: a repeatable MCP protocol probe and build evidence suitable for the Azure deployment path.

- [ ] **Step 1: Write the protocol probe**

Send `initialize`, `notifications/initialized`, and `tools/list` JSON-RPC
frames to `python -m agent_maturity.mcp`. Run once without elicitation and once
with:

```json
{"capabilities":{"elicitation":{}}}
```

Parse stdout as JSON and require 11 and 12 unique `maturity_*` tools
respectively. Treat non-JSON stdout, stderr failures, or nonzero exit as hard
failures.

- [ ] **Step 2: Run the probe**

Run:

```bash
PYTHONPATH=hosted-agent/vendor/agent-maturity \
  python hosted-agent/tests/probe_maturity_mcp.py
```

Expected: `agent-maturity MCP probe passed: 11 tools, 12 with elicitation`.

- [ ] **Step 3: Build the production image**

Run:

```bash
docker build -f hosted-agent/Dockerfile -t digibuddy-skills:verify .
```

Expected: build succeeds, reports 11 packaged global skills, and passes the
Node.js version assertion.

- [ ] **Step 4: Probe the built image**

Run the image with the MCP module as its command and feed the same protocol
probe. Confirm that no host checkout, package install, or network fetch is
needed.

- [ ] **Step 5: Validate the Azure deployment descriptor**

Run the repository's existing Azure Developer CLI validation or dry-run
command if available. Confirm `azure.yaml` still targets
`hosted-agent/Dockerfile` with `remoteBuild: true`.

- [ ] **Step 6: Commit**

```bash
git add hosted-agent/tests/probe_maturity_mcp.py \
  hosted-agent/tests/test_skill_bundle.py
git commit -m "test: verify bundled maturity MCP"
```

- [ ] **Step 7: Deploy when an Azure environment is configured**

Run `azd env get-values` without printing secret values, then run:

```bash
azd deploy digibuddy-codex
```

Expected: the Hosted Agent deployment completes successfully. If no selected
environment or required secret exists, stop after the verified image and
report the exact missing Azure prerequisite without inventing values.
