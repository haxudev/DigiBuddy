# Business Agent Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a business agent an administrator-defined unit: an administrator equips a profile with skills and MCP tools, a user addresses one agent with `@`, and a developer supplies capabilities as packs without rebuilding the image.

**Architecture:** The adapter already owns a configuration plane over Codex — five documents in a shared store, re-read at each turn boundary, with a runtime fingerprint that replaces the Codex process when it changes. This plan completes that plane instead of adding a layer. It first makes the plane safe to carry credentials and executable-code approvals (versioning, conditional writes, fail-closed resolution, kill switches), then makes the server authoritative about which profile is running, then scopes credentials to that profile, and only then admits developer-supplied capabilities.

**Tech Stack:** Python 3.12 standard library, `unittest`, Codex `app-server` stdio JSON-RPC, TOML configuration rendering, Next.js 16 App Router, React 19, TypeScript, `node --test`, Azure Blob with Entra ID, Docker.

Design: `docs/superpowers/specs/2026-08-24-business-agent-plane-design.md` (revision 2).

## Global Constraints

- Binding granularity is the session, and the **server** decides it. Every response reports the effective profile; the console displays and locks on that, never on its own request. Per-message routing is out of scope.
- Profile resolution fails closed. An unknown, deleted or malformed profile is an error, never a silent fallback to the unrestricted default. Fallback to the configured default applies only when no profile was requested at all.
- Per-profile credential isolation is delivered as T1–T3 and is **not** a hard boundary against prompt injection. T2 and T3 are settled by measurement against the built image, not by assumption. Documentation must say what is and is not achieved, and name separate deployments (T4) as the escalation path.
- Capability selection (`skills`, `tools`, `mcp_servers`) stays a list of names. Credentials live in a separate write-only document. No secret value is ever returned by a read API or held in the profile editor.
- Executable capabilities — uploaded tools and stdio MCP servers — deploy inactive. Activation is a separate action bound to the exact artifact digest, and any digest change revokes it.
- No new Azure service. The configuration container and its managed identity already exist; Key Vault is not introduced.
- Every configuration document carries `schema_version`. A runtime meeting an unknown version keeps its last good state instead of reinterpreting the document.
- `profiles.json` and the capability registry are written conditionally and report a conflict rather than overwriting. Superseded artifact blobs are retained, not deleted inside the request that supersedes them.
- A malformed document or a bad artifact must never take the agent offline. Skip the bad entry, keep the runtime up — except where failing closed is the point, which is profile identity.
- Every registry artifact path stays derived from `(name, sha256)` and is never taken from a request.
- Credential binding and capability packs each ship behind an environment kill switch, default off, so the Web UI and hosted agent can roll independently.
- Test commands run in subshells. Every frontend checkpoint runs tests, lint and build. A step that expects a failing test must state the behaviour that fails, not a type that Node erases.

---

### Task 1: Configuration-plane foundation

Everything later in this plan puts either a credential or an executable-code approval into these documents. This task makes that survivable.

**Files:**
- Modify: `hosted-agent/codex_adapter/config_store.py`
- Modify: `hosted-agent/codex_adapter/config.py`
- Modify: `hosted-agent/codex_adapter/profiles.py`
- Modify: `hosted-agent/codex_adapter/skills.py`
- Modify: `hosted-agent/codex_adapter/client.py`
- Modify: `hosted-agent/tests/test_config_store.py`
- Modify: `hosted-agent/tests/test_profiles.py`
- Modify: `hosted-agent/tests/test_config.py`
- Modify: `webui/src/lib/admin-config.ts`
- Modify: `webui/src/lib/admin-config.test.ts`
- Modify: `webui/src/lib/skill-import.ts`
- Modify: `webui/src/lib/skill-import.test.ts`
- Modify: `webui/src/app/api/admin/config/route.ts`
- Modify: `webui/src/app/api/admin/skills/route.ts`

**Interfaces:**
- Consumes: the five documents at `hosted-agent/codex_adapter/config_store.py:39-51`, the store interface at `webui/src/lib/admin-config.ts:316-324`, and the profile resolver at `hosted-agent/codex_adapter/profiles.py:104-113`.
- Produces: versioned documents; conditional writes with a conflict result; fail-closed profile resolution; retained superseded blobs; two kill switches; a catalogue republished when the registry changes.

- [ ] **Step 1: Write failing foundation tests**

Add tests asserting behaviour, not shape:

- `resolve_profile()` returns the configured default when nothing was requested, but **raises** for a non-empty name that is not in the document.
- A profile whose `skills` is a string or a number is rejected rather than parsed as `None` (today `hosted-agent/codex_adapter/profiles.py:57-65` turns it into "allow everything").
- A document carrying an unknown `schema_version` is refused and the previously loaded value is kept.
- A conditional write whose expected revision no longer matches reports a conflict and leaves the stored document unchanged.

- [ ] **Step 2: Run the tests to verify failure**

```bash
(cd hosted-agent && python -m unittest tests.test_profiles tests.test_config_store tests.test_config -v)
(cd webui && npm test)
```

Expected: FAIL. Name the assertion that fails for each new test and confirm it is the intended one, not an import or fixture error.

- [ ] **Step 3: Version the documents**

Add `schema_version` to every document produced by `webui/src/lib/admin-config.ts` and read by `hosted-agent/codex_adapter/config_store.py`. Readers accept the current version and the unversioned legacy shape; anything else is refused with a log line and the last good value is retained.

- [ ] **Step 4: Make profile resolution fail closed**

Change `resolve_profile()` (`hosted-agent/codex_adapter/profiles.py:104-113`) to distinguish three cases: nothing requested, requested and known, requested and unknown. Only the first falls back. Tighten `_names()` so a malformed selection is invalid rather than unrestricted. Surface the failure to the caller as a typed error so Task 3 can report it to the user.

- [ ] **Step 5: Add conditional writes and retention**

Extend the store interface on both sides to return a revision with every read and to accept an expected revision on write. Use the Azure Blob ETag for `BlobConfigStore` (`webui/src/lib/admin-config.ts:436-445` currently uploads unconditionally) and a revision field for the file store. Map a precondition failure to a `409` in the admin routes. Stop deleting superseded bundles inside the deploy request (`webui/src/lib/skill-import.ts:306,313-315`); record them for later collection instead.

- [ ] **Step 6: Republish the catalogue when the registry changes**

`_publish_catalogue()` runs only in `CodexRuntime.__init__` (`hosted-agent/codex_adapter/client.py:72-80`), so a hot-deployed capability never reaches the console. Republish it whenever the registry fingerprint changes at a turn boundary.

- [ ] **Step 7: Add the kill switches**

Introduce `DIGIBUDDY_ENABLE_PROFILE_CREDENTIALS` and `DIGIBUDDY_ENABLE_CAPABILITY_PACKS`, both defaulting to off, and read them in one place each. Every later task lands behind its flag.

- [ ] **Step 8: Run every suite**

```bash
(cd hosted-agent && python -m unittest discover -s tests -v)
(cd webui && npm test && npm run lint && npm run build)
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add hosted-agent/codex_adapter webui/src/lib/admin-config.ts \
  webui/src/lib/admin-config.test.ts webui/src/lib/skill-import.ts \
  webui/src/lib/skill-import.test.ts webui/src/app/api/admin \
  hosted-agent/tests
git commit -m "feat: version the configuration plane and fail closed on unknown profiles"
```

### Task 2: Security feasibility spike

T2 and T3 were drafted as if the answers were known. They are not, and one of the two original measures cannot work at all. This task establishes the facts before any secret is stored.

**Files:**
- Modify: `docs/architecture.md`
- Create: `.superclarity/` note or an equivalent recorded verdict (no product code)

**Interfaces:**
- Consumes: the deployed Hosted Agent, the chat console, and the built image.
- Produces: a recorded verdict for container/session mapping, parent-environment exposure and ambient identity reach, which determines how Task 4 and Task 5 are implemented.

- [ ] **Step 1: Measure the container-to-session mapping with a valid probe**

In conversation A: `create /workspace/probe-a.txt containing "A", then run: cat /proc/self/cgroup; cat /proc/sys/kernel/random/boot_id; ls -la /workspace`.

Leaving A open, in conversation B: `run: cat /proc/self/cgroup; cat /proc/sys/kernel/random/boot_id; ls -la /workspace`.

Read the result as follows. B seeing `probe-a.txt`, or a matching boot id and cgroup, is **conclusive evidence of reuse**. The absence of both is **one scheduling observation, not a guarantee** — record it as such. Do not use `echo $$`, which reports a shell, and do not use artifact delivery, which cannot fail here: B snapshots the workspace at its own turn start (`hosted-agent/codex_adapter/client.py:113`), so A's finished file is already in B's baseline.

Repeat at least three times, including one attempt after leaving the agent idle long enough to be recycled.

- [ ] **Step 2: Measure parent-environment exposure**

From a conversation, run `cat /proc/1/environ | tr '\0' '\n' | cut -d= -f1`. Record whether the adapter's variable names are readable by the Codex process. Then confirm whether making the adapter undumpable closes it, by testing `prctl(PR_SET_DUMPABLE, 0)` on a same-UID parent in the built image and repeating the read.

- [ ] **Step 3: Measure what the ambient identity still reaches**

From a conversation, attempt to obtain a managed-identity token both through the Azure SDK and through the raw endpoints, and attempt to read one configuration document with it. Record exactly what succeeds.

Then confirm the counter-constraint: `src/tools/azure_blob.py:53-74` deliberately uses that identity, so establish whether the shipped delivery tool still works under any restriction being considered.

- [ ] **Step 4: Record the verdict and its consequences**

Write the measured facts into `docs/architecture.md`, replacing the unverified claim at `docs/architecture.md:82`. State the date and the method. Do not restate the assumption.

The verdict decides three things: whether T2 is implemented as an undumpable adapter or something stronger; whether T3 can withhold the identity from Codex without removing the Blob capability, or whether the remaining exposure is accepted and documented; and whether workspace containment in Task 4 is a correctness fix or also a live defect repair.

- [ ] **Step 5: Commit**

```bash
git add docs/architecture.md
git commit -m "docs: record measured hosted-agent isolation and identity exposure"
```

### Task 3: Authoritative session binding

Depends on Task 1 for fail-closed resolution.

**Files:**
- Modify: `hosted-agent/main.py`
- Modify: `hosted-agent/codex_adapter/client.py`
- Modify: `hosted-agent/codex_adapter/session_map.py`
- Modify: `hosted-agent/tests/test_client.py`
- Modify: `hosted-agent/tests/test_session_map.py`
- Modify: `webui/src/app/api/agent/route.ts`
- Modify: `webui/src/lib/sessions.ts`
- Modify: `webui/src/lib/sessions.test.ts`
- Modify: `webui/src/app/page.tsx`
- Modify: `webui/src/components/AgentCapabilities.tsx`
- Modify: `README.md`
- Modify: `README.zh-CN.md`

**Interfaces:**
- Consumes: the thread binding at `hosted-agent/codex_adapter/client.py:101-104` and `hosted-agent/codex_adapter/session_map.py:13-16`, and the AG-UI state snapshot at `webui/src/app/api/agent/route.ts:250-257`.
- Produces: an effective-profile acknowledgement on every response; a session that stores the requested and the effective profile; a picker that locks on the acknowledgement; a typed error for a contradictory or unresolvable profile.

- [ ] **Step 1: Write failing binding tests**

Assert that the runtime reports the profile it actually used; that a bound thread receiving a different `metadata.profile` keeps its binding and reports the contradiction rather than discarding it silently; that a request naming an unknown profile fails instead of running as the default; and that a session restores its bound profile after a reload.

- [ ] **Step 2: Run the tests to verify failure**

```bash
(cd hosted-agent && python -m unittest tests.test_client tests.test_session_map -v)
(cd webui && npm test)
```

Expected: FAIL, because nothing currently returns the effective profile.

- [ ] **Step 3: Report the effective profile from the runtime**

Emit the resolved profile name, its display name and the binding status from `hosted-agent/main.py`, alongside the existing output items. Include it for a contradiction and for a resumed conversation, because those are the cases the console cannot infer.

- [ ] **Step 4: Carry it through the proxy into session state**

Extend the AG-UI `STATE_SNAPSHOT` at `webui/src/app/api/agent/route.ts:250-257` to include the effective profile. Add `requestedProfile` and `boundProfile` to `ChatSession` (`webui/src/lib/sessions.ts:7-15`) and validate both in `parseSessions` (`webui/src/lib/sessions.ts:100-135`); a stored session without them migrates deterministically to empty strings.

- [ ] **Step 5: Make the console follow the session, not the page**

Delete the page-level `profile` state at `webui/src/app/page.tsx:110` and derive it from the active session. Send the session's requested profile in the forwarded props at `webui/src/app/page.tsx:249-255`. Let `selectSession` follow the session it switches to (`webui/src/app/page.tsx:288-296`) and `createNewSession` accept an explicit profile (`webui/src/app/page.tsx:298-302`).

- [ ] **Step 6: Express the binding in the UI**

Give `AgentCapabilities` a bound state driven by `boundProfile`, not by `previousResponseId`. While a first turn is in flight the picker is disabled, because the server may already have bound it. Once bound, the control reports the agent in force and offers to start a new conversation with a different one. If the server reports a contradiction or an unresolvable profile, show it rather than failing silently.

- [ ] **Step 7: Run both suites**

```bash
(cd hosted-agent && python -m unittest discover -s tests -v)
(cd webui && npm test && npm run lint && npm run build)
```

Expected: PASS.

- [ ] **Step 8: Manual verification**

Switch sessions and confirm the picker follows. Reload and confirm it still matches the bound agent. Interrupt a first turn and confirm the displayed agent and the next turn's behaviour agree. Delete a profile that a session is bound to and confirm the session reports an error instead of quietly running as the default.

- [ ] **Step 9: Fix the documentation drift**

`README.md:124` says chat users pick a profile in the session panel, and `README.zh-CN.md:105` repeats it. The control is in the chat header, and `SessionSidebar.tsx` contains no profile logic. Correct both and describe the session-level binding rule.

- [ ] **Step 10: Commit**

```bash
git add hosted-agent/main.py hosted-agent/codex_adapter hosted-agent/tests \
  webui/src/app/api/agent/route.ts webui/src/lib/sessions.ts \
  webui/src/lib/sessions.test.ts webui/src/app/page.tsx \
  webui/src/components/AgentCapabilities.tsx README.md README.zh-CN.md
git commit -m "fix: make the server authoritative about the bound agent profile"
```

### Task 4: Workspace containment

Unconditional. Task 2 decides whether this repairs a live defect or aligns the code with the documented model, not whether it happens.

**Files:**
- Modify: `hosted-agent/codex_adapter/config.py`
- Modify: `hosted-agent/codex_adapter/client.py`
- Modify: `hosted-agent/codex_adapter/session_map.py`
- Modify: `hosted-agent/codex_adapter/artifacts.py`
- Modify: `hosted-agent/main.py`
- Modify: `hosted-agent/codex_adapter/attachments.py`
- Modify: `hosted-agent/tests/test_artifacts.py`
- Modify: `hosted-agent/tests/test_client.py`
- Modify: `hosted-agent/tests/test_attachments.py`

**Interfaces:**
- Consumes: the thread binding from `hosted-agent/codex_adapter/session_map.py` and the global workspace at `hosted-agent/codex_adapter/config.py:99`.
- Produces: an opaque workspace id created before any turn side effect, and uploads, working directory, snapshots and artifact detection all confined to it.

- [ ] **Step 1: Write failing containment tests**

Assert that two conversations resolve to different workspace roots; that `changed_artifacts()` for one never reports a file created by the other; that an attachment lands inside the conversation's own root; and that a resumed conversation returns to the same root.

- [ ] **Step 2: Run the tests to verify failure**

```bash
(cd hosted-agent && python -m unittest tests.test_artifacts tests.test_client tests.test_attachments -v)
```

Expected: FAIL, because the workspace is one global path.

- [ ] **Step 3: Create the workspace id before any side effect**

Attachments are stored in `hosted-agent/main.py:71-83` before `stream_turn` resolves anything, so the id cannot be derived from the Codex thread. Generate an opaque id when a conversation is first seen, persist it in `ThreadBinding` alongside the thread and profile, and migrate existing bindings without one.

- [ ] **Step 4: Route everything through it**

Point uploads, the Codex working directory, `thread/start` and `thread/resume`, `snapshot_workspace()` and `changed_artifacts()` (`hosted-agent/codex_adapter/client.py:113,151`) at the derived root. Keep the deliverables convention relative to it so `hosted-agent/AGENTS.md` and `src/AGENTS.md` stay accurate, and update the hard-coded `/workspace` guidance in both if the visible path changes.

- [ ] **Step 5: Name the property honestly**

Two same-UID Codex processes can still read each other's directories. Document this as containment — correct attribution and no accidental cross-reads — and not as isolation.

- [ ] **Step 6: Run the runtime suite**

```bash
(cd hosted-agent && python -m unittest discover -s tests -v)
```

Expected: PASS.

- [ ] **Step 7: Re-run the Task 2 probe**

Repeat Task 2 Step 1 against the rebuilt image. Expected: conversation B cannot see conversation A's probe file, whatever the container mapping turns out to be.

- [ ] **Step 8: Commit**

```bash
git add hosted-agent/codex_adapter hosted-agent/main.py hosted-agent/tests \
  hosted-agent/AGENTS.md src/AGENTS.md
git commit -m "fix: confine each conversation to its own workspace"
```

### Task 5: Credential scoping

Depends on Task 1 for the plane and Task 2 for the verdict. Ships behind `DIGIBUDDY_ENABLE_PROFILE_CREDENTIALS`.

**Files:**
- Modify: `hosted-agent/codex_adapter/config.py`
- Modify: `hosted-agent/codex_adapter/profiles.py`
- Modify: `hosted-agent/codex_adapter/client.py`
- Modify: `hosted-agent/codex_adapter/config_store.py`
- Modify: `hosted-agent/main.py`
- Modify: `hosted-agent/codex_adapter/events.py`
- Modify: `hosted-agent/tests/test_config.py`
- Modify: `hosted-agent/tests/test_profiles.py`
- Modify: `hosted-agent/Dockerfile`
- Modify: `webui/src/lib/admin-config.ts`
- Modify: `webui/src/lib/admin-config.test.ts`
- Modify: `webui/src/app/admin/page.tsx`
- Create: `webui/src/app/api/admin/credentials/route.ts`
- Modify: `docs/architecture.md`

**Interfaces:**
- Consumes: `prepare_codex_environment()` (`hosted-agent/codex_adapter/config.py:551-591`), which already builds a fresh environment per profile, and the restart guarantee in `runtime_fingerprint()` (`hosted-agent/codex_adapter/config.py:417-443`).
- Produces: an explicit child environment; a separate write-only credential document; capability slots bound per profile; secret-safe logging.

- [ ] **Step 1: Inventory the environment before restricting it**

Record every variable the payload actually reads, because an allowlist written from memory will break shipped tools:

| Source | Variables |
| --- | --- |
| `src/tools/azure_blob.py:40-74` | `DIGIBUDDY_BLOB_SERVICE_URI`, `DIGIBUDDY_BLOB_CONTAINER`, `DIGIBUDDY_BLOB_LINK_TTL_HOURS`, `AZURE_CLIENT_ID` |
| `src/tools/sharepoint.py:48-65` | `DIGIBUDDY_GRAPH_TENANT_ID`, `DIGIBUDDY_GRAPH_CLIENT_ID`, `DIGIBUDDY_GRAPH_CLIENT_SECRET`, `DIGIBUDDY_GRAPH_SCOPES`, `DIGIBUDDY_GRAPH_USER_ASSERTION`, `DIGIBUDDY_GRAPH_AUTHORITY_HOST` |
| `src/tools/m365_cli.py:520-523` | `HOME` |
| `hosted-agent/Dockerfile:5-12,48` | `PATH`, `HOME`, `CODEX_HOME`, `CODEX_WORKSPACE`, `DIGIBUDDY_PAYLOAD_ROOT`, `PYTHONPATH`, `PYTHONUNBUFFERED`, `PYTHONDONTWRITEBYTECODE` |
| `hosted-agent/codex_adapter/config.py:578-590` | `DIGIBUDDY_SKILLS_ROOT`, `DIGIBUDDY_TOOLS_ROOT`, `DIGIBUDDY_PROFILE`, `DIGIBUDDY_MODEL_API_KEY`, `OPENAI_API_KEY` |

Note which of these are secrets that should become profile-bound rather than container-wide: the Graph client secret is the clearest case.

- [ ] **Step 2: Write failing environment and credential tests**

Assert that the dict returned by `prepare_codex_environment()` contains the runtime essentials and the `DIGIBUDDY_*` roots; does **not** contain `DIGIBUDDY_CONFIG_URI`; does **not** contain an unrelated variable that is present in `os.environ`; contains a credential bound to profile `alpha` when `alpha` is active; and does **not** contain a credential bound only to profile `beta`. Add a test that every tool in the inventory still finds what it needs.

- [ ] **Step 3: Run the tests to verify failure**

```bash
(cd hosted-agent && python -m unittest tests.test_config -v)
```

Expected: FAIL, because `os.environ.copy()` at `hosted-agent/codex_adapter/config.py:578` passes everything through.

- [ ] **Step 4: Build the child environment explicitly (T1)**

Replace `os.environ.copy()` with an environment constructed from the inventory plus the active profile's bindings. Do not preserve variables by prefix: a wildcard over `NODE_*` or `PYTHON_*` would readmit `NODE_OPTIONS` and module-path overrides, which is a code-execution channel, not a compatibility measure.

- [ ] **Step 5: Add the credential model**

Keep `skills`, `tools` and `mcp_servers` as name lists. Add a `credential_bindings` map on the profile from a fixed capability slot to an opaque credential id, and store values in a separate write-only document keyed by profile and slot. Reject reserved environment names, cross-profile references, NUL bytes and oversize values. Include the binding in `profile_fingerprint()` so a rebinding restarts the process, and fingerprint resolved *values* with a process-keyed digest so a rotation under the same id is also detected — without putting plaintext into the public profile fingerprint.

- [ ] **Step 6: Resolve the MCP bearer token per profile**

Change the handling at `hosted-agent/codex_adapter/config.py:250-252` from naming a container-level variable to resolving the active profile's slot and injecting only that value into the child environment.

- [ ] **Step 7: Run the runtime suites**

```bash
(cd hosted-agent && python -m unittest tests.test_config tests.test_profiles tests.test_client -v)
```

Expected: PASS.

- [ ] **Step 8: Close the parent environment (T2)**

Implement the measure Task 2 established. If the verdict is the undumpable adapter, set it once at startup and assert in a container test that `/proc/1/environ` is no longer readable from a same-UID child. Do not attempt a UID switch through `create_subprocess_exec`: the adapter runs as unprivileged `agent` (`hosted-agent/Dockerfile:42-50`) and cannot change UID, and a different UID could not read the mode-`0600` Codex configuration (`hosted-agent/codex_adapter/config.py:561-566`).

- [ ] **Step 9: Apply the T3 verdict**

Remove `DIGIBUDDY_CONFIG_URI` from the child. Then act on what Task 2 measured about the ambient identity: either apply the restriction that was shown not to break `src/tools/azure_blob.py`, or record that the identity remains reachable and that this is the accepted residual risk. Do not weaken the container to obtain a restriction, and do not claim a tier that was not demonstrated.

- [ ] **Step 10: Make logging secret-safe**

The adapter logs whole translated events (`hosted-agent/main.py:151-154`), tool command text (`hosted-agent/codex_adapter/events.py:47-55`) and raw Codex stderr (`hosted-agent/codex_adapter/client.py:341-345`). Reduce production logging to types, ids, status and timing. Add a canary test asserting a known secret never appears in logs, responses, the rendered `config.toml`, or exception text.

- [ ] **Step 11: Add the write-only admin surface**

Add a credentials route that returns only slot names and whether each is set, and supports explicit keep, rotate and clear. Never return a value; never include credentials in `/api/profiles`. Merge by profile name and slot, not by array position, so a rename or reorder in the profiles editor cannot move a secret. Extend `webui/src/lib/admin-config.test.ts` accordingly.

- [ ] **Step 12: Run the console suite**

```bash
(cd webui && npm test && npm run lint && npm run build)
```

Expected: PASS.

- [ ] **Step 13: State the security position**

Update `docs/architecture.md` with what T1–T3 achieve and what they do not, including the measured identity verdict. Name T4 as the escalation path. Correct the claim at `hosted-agent/codex_adapter/profiles.py:7-9` to describe the mechanism that now exists and its limits.

- [ ] **Step 14: Commit**

```bash
git add hosted-agent webui/src/lib/admin-config.ts webui/src/lib/admin-config.test.ts \
  webui/src/app/admin/page.tsx webui/src/app/api/admin/credentials \
  docs/architecture.md
git commit -m "feat: scope credentials to the active agent profile"
```

### Task 6: Capability pack ingestion

Validation and storage only. Nothing uploaded executes in this task. Ships behind `DIGIBUDDY_ENABLE_CAPABILITY_PACKS`.

**Files:**
- Modify: `webui/src/lib/skill-bundle.ts`
- Modify: `webui/src/lib/skill-bundle.test.ts`
- Modify: `webui/src/lib/skill-import.ts`
- Modify: `webui/src/lib/skill-import.test.ts`
- Modify: `webui/src/lib/admin-config.ts`
- Modify: `webui/src/lib/admin-config.test.ts`
- Modify: `webui/src/app/api/admin/skills/route.ts`
- Modify: `webui/src/app/api/admin/skills/import/route.ts`
- Modify: `webui/src/app/api/admin/skills/preview/route.ts`
- Modify: `webui/src/app/admin/page.tsx`
- Modify: `hosted-agent/codex_adapter/skills.py`
- Modify: `hosted-agent/tests/test_skills.py`

**Interfaces:**
- Consumes: the explosion pipeline at `webui/src/lib/skill-bundle.ts:484-580`, the manifest parser at `webui/src/lib/skill-bundle.ts:214-294`, and the registry normaliser at `webui/src/lib/admin-config.ts:232-271`.
- Produces: a versioned manifest declaring skills, tools and MCP servers; one typed, content-addressed artifact per declaration; a pack receipt; digest-bound preview.

- [ ] **Step 1: Write failing ingestion tests**

Cover a manifest declaring `tools[]` and `mcp_servers[]`; a tool-only archive and an MCP-only archive, both of which must now succeed; declared paths that must exist inside the archive and pass the existing traversal and symlink checks; an MCP declaration naming an absolute path, a shell wrapper, a reserved environment name or a literal secret, all of which must be refused; and a deploy request whose digest does not match the preview it claims.

Note that "a manifest declaring nothing is rejected" is **already** true at `webui/src/lib/skill-bundle.ts:262-264`, so it is not a red test — extend it to the new kinds instead.

- [ ] **Step 2: Run the tests to verify failure**

```bash
(cd webui && npm test)
```

Expected: FAIL, and confirm each failure is the new assertion rather than a fixture error.

- [ ] **Step 3: Extend the manifest and emit typed artifacts**

Add `schema_version`, `tools[]` and `mcp_servers[]` to the manifest. Explosion emits one content-addressed artifact per declaration, each carrying its kind. Keep every existing safety property: size, entry-count and symlink limits, the frontmatter-versus-directory name check, and normalised file modes.

- [ ] **Step 4: Relax the skill-shaped assumption in the runtime**

`extract_bundle()` requires a root `SKILL.md` (`hosted-agent/codex_adapter/skills.py:176-177`), which makes tool-only and MCP-only artifacts impossible. Validate instead that the declared entrypoint for the artifact's kind exists. The digest check stays first and unchanged.

- [ ] **Step 5: Bind approval to bytes**

Preview stages the exact artifact bytes, or issues a receipt over the digest and canonical manifest. Deployment requires that receipt and rejects a mismatch. This closes the gap where a URL import fetches once for preview and again for deployment (`webui/src/app/admin/page.tsx:263-313`, `webui/src/app/api/admin/skills/import/route.ts:25-36`) and where the deploy API can be called with no preview at all (`webui/src/app/api/admin/skills/route.ts:35-53`).

- [ ] **Step 6: Extend the registry and add the pack receipt**

Grow `normaliseSkills` (`webui/src/lib/admin-config.ts:232-271`) into a capability registry recording kind, declaration and approval state, keeping the path derived from `(name, sha256)` at `webui/src/lib/admin-config.ts:260`. Add a receipt naming the pack, its source, its schema version and the digests it produced, so one archive's effects can be seen and withdrawn together. Preserve the existing rule that redeploying a disabled entry does not re-enable it.

- [ ] **Step 7: Show it in the console without offering activation**

Display declared tools and MCP servers in the preview, marking each MCP server as a command the runtime would execute at Codex start. Deploy them inactive. Activation belongs to Task 7.

- [ ] **Step 8: Run every suite**

```bash
(cd webui && npm test && npm run lint && npm run build)
(cd hosted-agent && python -m unittest discover -s tests -v)
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add webui/src/lib webui/src/app/api/admin/skills webui/src/app/admin/page.tsx \
  hosted-agent/codex_adapter/skills.py hosted-agent/tests/test_skills.py
git commit -m "feat: ingest capability packs as typed content-addressed artifacts"
```

### Task 7: Capability pack activation

Depends on Task 5, because activation is the point at which uploaded code inherits an environment. Depends on Task 6 for the artifacts.

**Files:**
- Modify: `hosted-agent/codex_adapter/skills.py`
- Modify: `hosted-agent/codex_adapter/config.py`
- Modify: `hosted-agent/codex_adapter/client.py`
- Modify: `hosted-agent/tests/test_skills.py`
- Modify: `hosted-agent/tests/test_config.py`
- Modify: `webui/src/lib/admin-config.ts`
- Modify: `webui/src/lib/admin-config.test.ts`
- Modify: `webui/src/app/api/admin/skills/route.ts`
- Modify: `webui/src/app/admin/page.tsx`
- Modify: `docs/architecture.md`
- Modify: `docs/api.md`

**Interfaces:**
- Consumes: the typed artifacts and receipt from Task 6, the scoped child environment from Task 5, profile filtering (`hosted-agent/codex_adapter/config.py:229-230`) and the registry fingerprint (`hosted-agent/codex_adapter/config.py:434`).
- Produces: a digest-bound approval state machine; trusted launchers for pack tools; enabled stdio declarations rendered into the Codex configuration; an observed-state catalogue.

- [ ] **Step 1: Write failing activation tests**

Assert that a pending artifact is not installed, not offered to profiles and not rendered into the configuration; that approving it records the digest; that redeploying different bytes under the same name returns it to pending; that a profile which does not allow a capability never receives it; that an approved pack tool is reachable without the pack directory appearing on the global `PYTHONPATH`; and that a corrupt artifact leaves the previously installed capabilities intact.

- [ ] **Step 2: Run the tests to verify failure**

```bash
(cd hosted-agent && python -m unittest tests.test_skills tests.test_config -v)
(cd webui && npm test)
```

Expected: FAIL.

- [ ] **Step 3: Add the approval state machine**

Record `pending`, `approved` and `revoked` separately from the operational `enabled` flag, with approver, timestamp and the approved digest. Any digest change resets to `pending`; today redeployment inherits the previous flag (`webui/src/lib/skill-import.ts:300`). Add a conditional-write approval endpoint that rejects a stale digest.

- [ ] **Step 4: Publish pack tools behind a launcher**

Do not extend `PYTHONPATH` with an uploaded directory: `hosted-agent/codex_adapter/config.py:584-586` prepends the tools root, so a `sitecustomize.py` inside a pack would run on every unrelated `python -m` call. Generate a launcher that puts only that artifact on `sys.path`, mirroring the vendoring shim the importer already produces (`webui/src/lib/skill-bundle.ts:296-319`).

- [ ] **Step 5: Render approved MCP servers only**

Merge approved, enabled stdio declarations into `render_codex_config()` (`hosted-agent/codex_adapter/config.py:334-376`) using paths inside the verified artifact. Derive the command from the hash-covered manifest, not from a mutable registry field. Keep the packaged-wins rule for name collisions and reject a pack that collides rather than partially installing it.

- [ ] **Step 6: Make installation survive a bad artifact**

`extract_bundle()` removes the live target before staging completes (`hosted-agent/codex_adapter/skills.py:179-196`). Stage first and swap, so a rejected artifact never leaves a gap, and one bad artifact never stops the healthy ones.

- [ ] **Step 7: Publish observed state**

Extend `build_catalogue()` (`hosted-agent/codex_adapter/config.py:267-298`) to report what is actually installed, including kind, approval state and any rejection reason, and republish it through the Task 1 mechanism. The console assigns only effective capabilities, replacing the optimistic union at `webui/src/app/admin/page.tsx:340-347`.

- [ ] **Step 8: Expose the stdio form in the MCP tab**

The runtime has always supported `command`, `args` and `env` (`hosted-agent/codex_adapter/config.py:253-260`); the console has only ever exposed remote HTTPS (`webui/src/app/admin/page.tsx:463-590`). Add the stdio form under the same approval gate.

- [ ] **Step 9: Run every suite**

```bash
(cd hosted-agent && python -m unittest discover -s tests -v)
(cd webui && npm test && npm run lint && npm run build)
```

Expected: PASS.

- [ ] **Step 10: Verify against the built image**

```bash
docker build -f hosted-agent/Dockerfile -t digibuddy-packs:verify .
```

Deploy a pack declaring one skill, one tool and one stdio MCP server. Confirm the skill is readable; the tool runs through its launcher; the MCP server is absent until approved and present afterwards; a restricted profile sees only what it allows; and a pack tool cannot shadow a payload module.

- [ ] **Step 11: Document the pack**

Describe the manifest, the typed artifacts, the digest-bound approval and the developer workflow in `docs/architecture.md` and `docs/api.md`, beside the existing skills plane. State plainly what the supply chain proves: integrity, not origin, with one approver.

- [ ] **Step 12: Commit**

```bash
git add hosted-agent webui/src docs/architecture.md docs/api.md
git commit -m "feat: activate pack capabilities under digest-bound approval"
```

### Task 8: Addressing an agent with @

Depends on Task 3.

**Files:**
- Modify: `webui/src/app/page.tsx`
- Modify: `webui/src/components/AgentCapabilities.tsx`
- Modify: `webui/src/lib/profile-capabilities.ts`
- Modify: `webui/src/lib/profile-capabilities.test.ts`
- Modify: `docs/features.md`

**Interfaces:**
- Consumes: `ChatSession.requestedProfile` and `boundProfile` from Task 3, the public profile list at `webui/src/app/api/profiles/route.ts`, and `describeProfiles()`.
- Produces: a leading-`@` trigger that binds an agent to a new conversation and explains the binding on an existing one.

- [ ] **Step 1: Write failing matcher tests**

A leading `@` in an otherwise empty, unbound composer opens the list; a partial name filters it; a selection resolves to exactly one canonical profile name; an unknown name resolves to none rather than guessing; and the token is removed from the text that is sent.

- [ ] **Step 2: Run the tests to verify failure**

```bash
(cd webui && npm test)
```

Expected: FAIL, because no matcher exists.

- [ ] **Step 3: Implement the trigger on unbound sessions**

Recognise only a leading `@query` in an empty, unbound composer. Reuse the existing capability data and the popover's dismissal and keyboard behaviour. Selecting records the requested profile and strips the token. Do not implement a general inline mention parser: under D1 a mention elsewhere cannot change anything, so parsing one would promise a capability the runtime does not have.

- [ ] **Step 4: Handle a bound session honestly**

In a bound session, `@` neither silently does nothing nor pretends to switch. It names the agent in force and offers one action: start a new conversation with the requested agent, carrying the profile through `createNewSession`.

- [ ] **Step 5: Run the suites**

```bash
(cd webui && npm test && npm run lint && npm run build)
```

Expected: PASS.

- [ ] **Step 6: Manual verification**

Confirm `@` binds a new conversation; that a bound conversation explains itself and hands off cleanly; and that a reload preserves the binding and its display.

- [ ] **Step 7: Document the interaction**

Describe the rule in `docs/features.md`: an agent is chosen when a conversation starts and stays for that conversation, because Codex fixes its base instructions when a thread starts.

- [ ] **Step 8: Commit**

```bash
git add webui/src/app/page.tsx webui/src/components/AgentCapabilities.tsx \
  webui/src/lib/profile-capabilities.ts webui/src/lib/profile-capabilities.test.ts \
  docs/features.md
git commit -m "feat: address an agent with @ when a conversation starts"
```

### Task 9: Release verification

**Files:**
- Create: `.github/workflows/ci.yml`
- Modify: `scripts/release_hosted_agent.py`
- Modify: `docs/quickstart.md`

**Interfaces:**
- Consumes: the release orchestrator and its version-cloning behaviour at `scripts/release_hosted_agent.py:1038-1050`.
- Produces: automated checks on every change, a flag-aware rollout, and a rehearsed rollback.

- [ ] **Step 1: Add application CI**

The only workflow builds documentation (`.github/workflows/pages.yml`). Add a job running the hosted-agent suite, the Web UI tests, lint and build, and a Docker build.

- [ ] **Step 2: Make the release flag-aware**

`_clone_version_payload()` copies the previous version's environment forward. Confirm it carries the two kill switches deliberately rather than by accident, and that no superseded credential variable is cloned into a new version.

- [ ] **Step 3: Roll out in order**

Release the dual-reading runtime first, then the console, then enable each flag. Verify the readiness and proxy checks between steps.

- [ ] **Step 4: Rehearse the rollback**

Disable both flags and confirm the agent returns to its pre-flag behaviour with the retained previous registry revision and artifact blobs.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml scripts/release_hosted_agent.py docs/quickstart.md
git commit -m "ci: verify the agent plane before and after rollout"
```

## Sequencing

```text
Task 1 (plane foundation)
   ├─→ Task 3 (authoritative binding) ──→ Task 8 (@mention)
   ├─→ Task 4 (workspace containment)
   └─→ Task 6 (pack ingestion, inert)
Task 2 (security spike) ──→ Task 5 (credential scoping)
                                 └─→ Task 7 (pack activation)  ←── Task 6
Task 9 (release verification) after any task that ships
```

Task 1 is a prerequisite for everything, because it is what makes the documents safe to carry the state the later tasks add. Task 2 runs in parallel with Task 1 and gates Task 5. Task 7 requires **both** Task 5 and Task 6: uploaded code must not execute before the child environment is scoped. Tasks 3, 4 and 6 are independent of each other once Task 1 lands.

## Acceptance matrix

| ID | Actor | Decision | Automated evidence | Deployment evidence |
| --- | --- | --- | --- | --- |
| A1 | Administrator | D5 | unknown or deleted profile fails closed | admin edit applies at the next turn |
| A2 | Administrator | D2 | profile `beta`'s credential absent from profile `alpha`'s child environment | credential rotates without redeploy |
| A3 | Administrator | D4 | redeploying different bytes returns an MCP server to pending | approved server appears only after confirmation |
| A4 | User | D1 | response reports the effective profile; session restores it after reload | picker matches the running agent |
| A5 | User | D1 | unknown bound profile surfaces an error | no silent default fallback |
| A6 | Developer | D3 | tool-only and MCP-only packs ingest and install | pack deploys with no image rebuild |
| A7 | Operator | — | full suites, lint and build green in CI | flags disable cleanly and roll back |
