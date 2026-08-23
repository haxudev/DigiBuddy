# Hosted Agent Release Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a safe one-command release path for routine DigiBuddy Hosted Agent and Web UI updates.

**Architecture:** A standard-library Python orchestrator runs local gates, builds an immutable ACR image, and uses Foundry v1 REST to clone the latest valid definition with a new image. Small pure helpers isolate selection and response parsing from subprocess and HTTP side effects.

**Tech Stack:** Python 3.11+ standard library, Azure CLI, Docker CLI, Azure Container Registry Tasks, Foundry v1 REST.

## Global Constraints

- Safe mode is the default; `--fast` and `--build-only` are explicit opt-outs.
- Never print tokens, model keys, or Hosted Agent environment-variable values.
- A release tag must include the current committed git SHA.
- Foundry versions are immutable; only a newly created failed version may be deleted.
- The online gate must exercise `maturity_get_question` and recognize `A1.qa`.
- The default release must deploy both `hosted-agent/Dockerfile` and
  `webui/Dockerfile`; `--skip-webui` is the explicit Agent-only override.
- Foundry list/get responses contain deployable fields under `definition`;
  helpers must accept that real API shape.

---

### Task 1: Pure release model and tests

**Files:**
- Create: `scripts/release_hosted_agent.py`
- Create: `tests/test_release_hosted_agent.py`

**Interfaces:**
- Produces: `ReleaseConfig`, `select_source_version(versions)`, `extract_output_text(payload)`, `make_image_tag(sha, now)`, and `release_receipt(...)`.

- [ ] **Step 1: Write failing unit tests**

Cover deterministic tags, rejecting malformed/latest invalid versions, choosing
the newest valid active Hosted Agent definition, concatenating Responses output
text, and ensuring receipts contain digest/version/response ID but no
environment variables.

- [ ] **Step 2: Run the focused tests**

Run: `python -m unittest tests/test_release_hosted_agent.py -v`

Expected: failure because `scripts.release_hosted_agent` does not exist.

- [ ] **Step 3: Implement the pure helpers**

Use dataclasses and typed standard-library functions. A valid source definition
must have `kind == "hosted"`, `status == "active"`, a non-empty
`container_configuration.image`, and a Responses protocol entry.

- [ ] **Step 4: Run the focused tests**

Run: `python -m unittest tests/test_release_hosted_agent.py -v`

Expected: all tests pass.

### Task 2: Release orchestration

**Files:**
- Modify: `scripts/release_hosted_agent.py`
- Modify: `tests/test_release_hosted_agent.py`
- Create: `scripts/release-hosted-agent.py`

**Interfaces:**
- Consumes: pure helpers from Task 1.
- Produces: `ReleaseRunner.run() -> dict[str, object]` and executable wrapper `scripts/release-hosted-agent.py`.

- [ ] **Step 1: Add failing orchestration tests**

Use a fake command/HTTP adapter to verify stage order, `--fast`,
`--build-only`, `--skip-webui`, bounded activation waits, online acceptance of
the required question, Web App image update/readiness/rollback, and deletion of
only the newly created Agent version after a failed Agent gate.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `python -m unittest tests/test_release_hosted_agent.py -v`

- [ ] **Step 3: Implement orchestration**

Implement subprocess execution without `shell=True`, Azure token retrieval in
memory, Foundry JSON requests through `urllib.request`, local container cleanup
in `finally`, ACR metadata lookup for both images, activation polling, online
Responses verification, Web App deployment with preservation of existing app
settings, condition-based HTTP readiness, targeted Web App rollback, and
`.azure/releases/<tag>.json` receipts.

- [ ] **Step 4: Run focused and existing tests**

Run:

```bash
python -m unittest tests/test_release_hosted_agent.py -v
cd hosted-agent && python -m unittest discover -s tests -p 'test_*.py'
cd .. && python hosted-agent/tests/probe_maturity_mcp.py
```

Expected: all pass.

### Task 3: Operator documentation and dry run

**Files:**
- Modify: `docs/quickstart.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: `scripts/release-hosted-agent.py --help`.
- Produces: documented first-time setup and routine release commands.

- [ ] **Step 1: Document routine release usage**

Make the script the default update path, document `--fast`, `--build-only`,
resource overrides, prerequisites, immutable tags, receipts, and rollback
behavior. Keep `azd` only as first-time provisioning guidance.

- [ ] **Step 2: Run local non-cloud checks**

Run:

```bash
python scripts/release-hosted-agent.py --help
python -m unittest tests/test_release_hosted_agent.py -v
git diff --check
```

- [ ] **Step 3: Execute one production release**

Run: `python scripts/release-hosted-agent.py`

Expected: two ACR digests, an active Foundry version, a successful online MCP
gate, an HTTP-healthy Web UI running the new tag, and a receipt under
`.azure/releases/`.

- [ ] **Step 4: Commit**

Commit the release script, tests, and documentation with the required Copilot
co-author trailer.
