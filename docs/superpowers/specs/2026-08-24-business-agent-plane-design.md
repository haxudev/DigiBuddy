# Business Agent Plane Design

## Goal

Make a business agent a first-class, administrator-defined unit of this product:

- An **administrator** defines an agent profile and equips it with skills and MCP
  tools, so that one business task executes precisely.
- A **user** addresses a specific agent with `@` and gets that agent's behaviour.
- A **developer** supplies skills and MCP tools as a vertical capability supply
  chain, without rebuilding the runtime image.

The bet this repository already made is correct and is kept: *a profile is data,
not an image; one runtime image serves every business agent*
(`hosted-agent/codex_adapter/profiles.py:3`). This design completes that bet
rather than introducing a new abstraction layer.

## What already exists

Codex `app-server` itself has no unified configuration plane. Its configuration
surface is process-level and filesystem-level: `$CODEX_HOME/config.toml`,
`$CODEX_HOME/skills/`, and the `baseInstructions` fixed at `thread/start`
(`hosted-agent/codex_adapter/client.py:209-219`). It has no multi-tenant model,
no runtime switching, and no registry.

The adapter in this repository has already built that plane on top of Codex. Five
documents in a shared store (`hosted-agent/codex_adapter/config_store.py:39-51`)
carry it:

| Document | Written by | Role |
| --- | --- | --- |
| `models.json` | Administrator | Model, endpoint, key |
| `mcp.json` | Administrator | MCP catalogue |
| `profiles.json` | Administrator | Business agent definitions |
| `skills.json` | Administrator, via the upload path | Deployed skill registry |
| `catalogue.json` | Runtime | What the image actually ships |

Hot application is already solved. `runtime_fingerprint()`
(`hosted-agent/codex_adapter/config.py:417-443`) hashes the rendered Codex
configuration, the skill registry, the assembled instructions, the profile and a
key digest; `_ensure_started()` compares it at every turn boundary and replaces
the Codex process when it changes
(`hosted-agent/codex_adapter/client.py:163-174`). Administrative edits therefore
apply without redeploying the image.

Against the three-role goal, the starting position is roughly:

| Goal | Status |
| --- | --- |
| Administrator defines profiles, equips skills and MCP | Present. `AgentProfile` (`hosted-agent/codex_adapter/profiles.py:26-46`), four admin tabs (`webui/src/app/admin/page.tsx`) |
| User addresses one agent | Partial. A header picker exists; there is no `@` syntax, and the binding semantics disagree between client and server |
| Developer supplies skills | Present. Upload or allowlisted URL import, dry-run preview, content-addressed blob, registry, SHA-256 re-verification at install |
| Developer supplies MCP tools | Absent. Only an image rebuild delivers one |

## Gaps

### Gap 0 — The container-to-session mapping is unverified

The adapter has no session concept at all. There is no `conversation`,
`session_id` or `x-ms-*` handling anywhere under `hosted-agent/`; the only
correlation key is `previous_response_id`. At the same time:

- the workspace is a single global path (`hosted-agent/codex_adapter/config.py:99`),
- artifact detection diffs that whole global path
  (`hosted-agent/codex_adapter/client.py:113`),
- and one lock serialises an entire turn including its streaming loop
  (`hosted-agent/codex_adapter/client.py:101`).

If one container serves several concurrent sessions, files created by session A
are detected by session B's diff and delivered to B. `docs/architecture.md:82`
asserts that Foundry session isolation is the security boundary, but nothing in
the code enforces or verifies it.

Measuring this is easy to get wrong, and the obvious probes do not answer it. A
shell's `echo $$` reports that shell, not the container. Watching whether a second
conversation receives the first one's deliverable cannot fail: the second
conversation snapshots the workspace at its own turn start
(`hosted-agent/codex_adapter/client.py:113`), by which time the earlier file is
already part of its baseline and can never be reported as changed. Only a direct
cross-read, and a boot or cgroup identity rather than a PID, says anything — and
even then a single negative observation describes one scheduling outcome, not a
guarantee. The design therefore treats the measurement as evidence and makes
containment unconditional.

### Gap 1 — Profile binding semantics disagree between client and server

The server binds a profile to a thread on the first turn and silently discards
any later `metadata.profile` (`hosted-agent/codex_adapter/client.py:101-104`,
`hosted-agent/codex_adapter/session_map.py:13-16`).

The client does not model this at all. `profile` is page-level React state
(`webui/src/app/page.tsx:110`) and `ChatSession` has no `profile` field
(`webui/src/lib/sessions.ts:7-15`). The selection is therefore sticky across
session switches, lost on reload, and freely changeable mid-conversation.

The user-visible consequence: switching to another agent updates the header and
the capability chips while the conversation keeps running the original profile,
with no indication. Reloading the page produces the inverse mismatch. Until this
is resolved, "address a specific agent" has no defined meaning.

The client also has no way to find out. The proxy returns only
`previousResponseId` in the AG-UI state (`webui/src/app/api/agent/route.ts:250-257`),
and a blank selection may still resolve to something through the `DIGIBUDDY_PROFILE`
environment default (`webui/src/lib/agent-proxy.ts:96-97`), so what the header
shows is a request, not an outcome.

Worse, resolution is fail-open. An unknown or deleted profile name falls back to
`digibuddy` and ultimately to the unrestricted built-in default
(`hosted-agent/codex_adapter/profiles.py:104-113`), and a malformed capability
list parses as `None`, which means "allow everything"
(`hosted-agent/codex_adapter/profiles.py:57-65`). Renaming a restricted profile
would silently widen every conversation bound to it.

### Gap 2 — A profile curates visibility; it does not constrain credentials

The code states the limitation plainly
(`hosted-agent/codex_adapter/profiles.py:7-9`): filtering keeps the prompt
focused, Codex has a full shell, and real isolation has to come from the
credentials a profile is granted. No per-profile credential mechanism exists.

The concrete leak is one line. `prepare_codex_environment()` starts from
`os.environ.copy()` (`hosted-agent/codex_adapter/config.py:578`), so the Codex
child inherits the entire parent environment: the model key, every value behind
an MCP `bearer_token_env_var` (`hosted-agent/codex_adapter/config.py:250-252`),
and `DIGIBUDDY_CONFIG_URI`. Because the container carries a managed identity and
Codex has full network egress (`CODEX_NETWORK_ACCESS=true` in `azure.yaml`),
an injected Codex turn can obtain a token from IMDS and read the whole
configuration store, including the model key in `models.json` and every deployed
bundle.

`src/AGENTS.md` tries to prevent this with prompt-level rules while listing
prompt injection as part of its own threat model. Prompt rules do not defend
against prompt injection.

### Gap 3 — The supply chain has three legs of unequal length

| Unit | Runtime supply path | Trust model |
| --- | --- | --- |
| Skill | Content-addressed bundle, registry, SHA-256 re-verified at install | Integrity, not provenance |
| Tool | None; image rebuild only | — |
| MCP | JSON document only; the runtime supports stdio servers (`hosted-agent/codex_adapter/config.py:253-260`) but the admin console exposes only remote HTTPS | Container-level credential |

`src/mcp.json` already registers `agent-maturity` as a local stdio server, which
proves the runtime capability is real and only the supply path is missing.

Separately, the deployed skill `version` is an incrementing label with no
semantics, no history and no rollback
(`webui/src/lib/skill-import.ts:242-246`); SHA-256 proves integrity, not origin;
and a single administrator's action takes effect immediately with no second
approver and no signature.

## Decisions

Five decisions are binding for this design.

**D1 — Binding granularity is the session.** `@` selects an agent when a
conversation starts; the conversation stays with that agent. This matches the
existing server behaviour and matches Codex, whose `baseInstructions` are fixed
at `thread/start`. Per-message routing was rejected: it would require a separate
Codex thread per profile plus context hand-off, which is an orchestrator and
sub-agent architecture, an order of magnitude more work.

The binding is authoritative on the server, so the server must say which profile
is in force. The response carries the resolved profile back to the client, and
the client displays and locks on that acknowledgement rather than on its own
request. `previous_response_id` stays what it already is — a resume cursor — and
is not promoted into a conversation identity.

**D2 — Per-profile credential isolation is required**, without physical
separation of business lines. Isolation is delivered by handing each Codex
process only its own profile's credentials, and is bounded by the fact that the
container's managed identity is ambient (see the security position below).

**D3 — The supply unit is one capability pack, delivered as typed capability
artifacts.** An administrator uploads or imports one archive; the console
validates it and explodes it into individually content-addressed artifacts —
skill, tool, or MCP server — recorded together under one pack receipt. The
runtime therefore continues to receive one simple, digest-verified artifact at a
time, which is the property that makes the existing installer safe.

The rejected alternative was storing the archive intact and teaching the runtime
to interpret a multi-capability pack. It would have replaced a verified
extraction path with a new one and made partial installation possible, for no
gain to the developer, who ships the same archive either way.

**D4 — Executable capability activation is separately confirmed and bound to a
digest.** A stdio MCP server is a command the runtime executes unconditionally at
Codex start, and an uploaded tool is a module the agent can run, so both are
deployed inactive. Activation names the exact artifact digest it approves; any
change to those bytes revokes the approval and requires a fresh confirmation.

**D5 — Every console-authenticated user may invoke every profile, and profile
resolution fails closed.** A profile is curation plus credentials, not a tenancy
boundary, and no per-user entitlement model is introduced in this design. What
does change is that an unknown, deleted, or malformed profile is an error rather
than a silent fallback to the unrestricted default.

This is a deliberate, reversible position, recorded because it is the one
assumption that would turn credential binding into privilege escalation if it
were wrong. The enforcement point is named in the plan, so adding entitlements
later is a change at one place rather than a redesign.

## Security position for credential isolation

D2 cannot be satisfied absolutely inside a single container, and this design does
not claim otherwise. Codex has a shell, full network egress and access to the
container's ambient managed identity. Anything the adapter can fetch, an injected
Codex can in principle fetch, because they share one container identity.

The design therefore takes a layered position and states the residual risk.

| Tier | Measure | Defends against | Status |
| --- | --- | --- | --- |
| T1 | Build the child environment from an explicit allowlist plus the active profile's bindings, instead of `os.environ.copy()` | Accidental cross-profile use; the model choosing another profile's credential | In scope |
| T2 | Make the adapter's own `/proc` entry unreadable by the Codex process | Reading the parent's environment through procfs | In scope, method decided by measurement |
| T3 | Keep the configuration-store URI out of the child, and establish what the ambient managed identity still reaches | Recovering the whole configuration store through the managed identity | In scope as a measured verdict, not an assumed outcome |
| T4 | Separate Foundry agent deployments, each with its own identity, store and RBAC | Everything | Out of scope; documented escalation path |

Two constraints govern how T2 and T3 are implemented, and both were established
against the running image rather than assumed.

**T2 cannot be a user-ID split as first drafted.** The adapter already runs as
the unprivileged `agent` user (`hosted-agent/Dockerfile:42-50`), so it cannot
launch a child under another UID, and a different UID could not read the
adapter-owned mode-`0600` Codex configuration
(`hosted-agent/codex_adapter/config.py:561-566`). The smaller measure that fits
the existing privilege model is to make the adapter process undumpable, so its
own `/proc/<pid>/environ` stops being readable by a same-UID child. The plan
verifies that empirically before the tier is claimed.

**T3 is a measurement, not a switch.** Removing `DIGIBUDDY_CONFIG_URI` and the
`AZURE_*` variables does not revoke the container's managed identity, which an
SDK or a raw token endpoint can still reach. Denying that identity to Codex would
also break a shipped capability: `src/tools/azure_blob.py:53-74` uses it
deliberately to publish deliverables. The plan therefore measures what the Codex
process can actually obtain and records the verdict; where the identity cannot be
withheld from Codex without removing a capability, the honest answer is that the
remaining exposure is accepted or the workload moves to T4.

T1 through T3 move the system from "no separation at all" to "meaningful
separation". They are not a hard boundary against a determined prompt-injection
attack. The security notes in `docs/architecture.md` must say so, and T4 must be
named as the escalation path for a business line that cannot accept the residual
risk.

Two further properties follow from taking D2 seriously:

- **Capability selection stays free of secrets.** `mcp_servers` remains a list of
  names, because every current consumer parses it that way
  (`hosted-agent/codex_adapter/profiles.py:57-65`,
  `webui/src/lib/admin-config.ts:114-120`,
  `webui/src/lib/profile-capabilities.ts:21-44`). Credentials live in a separate,
  write-only document keyed by profile and capability slot, so the public profile
  projection and the admin profile editor never carry a secret value.
- **Logging is a credential sink.** The adapter currently logs whole translated
  events, tool command text and raw Codex stderr
  (`hosted-agent/main.py:151-154`, `hosted-agent/codex_adapter/events.py:47-55`,
  `hosted-agent/codex_adapter/client.py:341-345`). Once a profile carries its own
  secret, that is a way for one profile's credential to outlive its process in a
  shared log, so the credential work includes tightening it.

The isolation that does hold is structural: because a profile change already
forces a process restart through `runtime_fingerprint`, a given Codex process is
only ever handed the credentials of its own profile. The adapter is trusted; the
Codex child is not.

## Configuration plane obligations

The plane is about to carry credentials and executable-code approvals, which
changes what its documents must guarantee.

- **Versioned.** Every document carries `schema_version`. A runtime that meets an
  unknown version refuses that document and keeps its last good state rather than
  silently reading it as an older shape.
- **Conditionally written.** `profiles.json` and the deployed-capability registry
  are read-modify-write from two independent surfaces, so both use a conditional
  write and report a conflict instead of overwriting. Blob writes are currently
  unconditional (`webui/src/lib/admin-config.ts:436-445`).
- **Recoverable.** A superseded artifact blob is retained rather than deleted
  inside the same request (`webui/src/lib/skill-import.ts:306,313-315`), so the
  previous known-good state can be restored.
- **Observed, not asserted.** `catalogue.json` is published once at construction
  (`hosted-agent/codex_adapter/client.py:72-80`) and advertises registry names
  without proving installation. It becomes an observed-state document, republished
  when the registry changes, so the console cannot offer a capability the runtime
  rejected.
- **Flagged.** Credential binding and capability packs each ship behind an
  environment kill switch, so the Web UI and the hosted agent can roll
  independently without a half-enabled plane.

## Capability pack

A pack is what a developer ships and an administrator approves. It is not what
the runtime installs.

The console already turns a messy source archive into normalised, individually
content-addressed bundles (`webui/src/lib/skill-bundle.ts:484-580`), and the
runtime already verifies and installs exactly one of those at a time
(`hosted-agent/codex_adapter/skills.py:149-196`). The pack extends that pipeline
rather than replacing it: the manifest may now declare three kinds of capability,
and explosion emits one typed artifact per declaration.

```text
skills[]       existing semantics, unchanged
tools[]        a directory plus the module the agent runs
mcp_servers[]  a bundle-relative entrypoint run under a fixed runtime
```

Consequences that fall out of this choice, each of which is a requirement:

- **The artifact stops being skill-shaped.** Extraction currently insists on a
  root `SKILL.md` (`hosted-agent/codex_adapter/skills.py:176-177`), which would
  make a tool-only or MCP-only pack impossible. The check becomes "the declared
  entrypoint of this artifact's kind exists", and the kind travels in the registry
  entry, where the digest already protects it.
- **A pack receipt records provenance.** One upload can produce several artifacts;
  the receipt names the pack, its source, its schema version and the digests it
  produced, so an administrator can see and withdraw what one archive introduced.
- **A pack tool never joins the global module path.** Prepending an uploaded
  directory to `PYTHONPATH` (`hosted-agent/codex_adapter/config.py:584-586`) would
  let a `sitecustomize.py` inside it execute on every unrelated `python -m` call.
  Pack tools are published behind a generated launcher that puts only that
  artifact on `sys.path`, which is the same technique the importer already uses
  for vendored libraries (`webui/src/lib/skill-bundle.ts:296-319`).
- **A pack MCP server is not an arbitrary command.** The declaration selects a
  fixed runtime and a path inside its own artifact. Absolute paths, shell
  wrappers, reserved environment names and literal secrets are refused; a server
  that needs a credential references a profile capability slot.
- **Approval is bound to bytes.** Deployment must present the digest a preview
  produced, and activation records the digest it approves, because preview and
  deployment are separate fetches today (`webui/src/app/admin/page.tsx:263-313`)
  and redeployment currently inherits the previous enabled flag
  (`webui/src/lib/skill-import.ts:300`).

Three existing mechanisms carry over unchanged: profile filtering
(`hosted-agent/codex_adapter/config.py:229-230`), hot restart through the registry
fingerprint (`hosted-agent/codex_adapter/config.py:434`), and the rule that the
registry path is always re-derived from name and digest rather than taken from a
request (`webui/src/lib/admin-config.ts:260`).

The admin console additionally exposes the stdio MCP form that the runtime has
supported all along (`hosted-agent/codex_adapter/config.py:253-260`,
`webui/src/app/admin/page.tsx:463-590`).

## Workspace containment

The adapter has no session concept and diffs one global workspace, so a container
that serves more than one conversation attributes files to the wrong one. The
platform's actual mapping is unknown and, as Gap 0 records, cheap to observe
wrongly: a second conversation snapshots *after* the first one's file already
exists, so it can never report that file as changed. A negative artifact
observation therefore proves nothing.

Containment is consequently unconditional rather than contingent on the probe. It
is also named honestly: giving each conversation its own workspace fixes artifact
attribution and stops accidental cross-reads, but two same-UID Codex processes can
still read each other's directories, so this is containment, not isolation.
Isolation would require a process or container boundary, which is T4.

## Addressing an agent

Under D1, `@` is meaningful only on the first message of a conversation.

- Typing `@` in an empty, unbound composer opens the profile list, reusing
  `/api/profiles` and `AgentCapabilities`.
- Selecting one records the requested profile on the session and removes the
  token from the text that is sent.
- The first turn returns the effective profile, which the session stores; from
  then on the conversation is bound and the picker reports it.
- Typing `@` for another agent in a bound conversation explains the binding and
  offers to start a new conversation with that agent.

This turns the server-side lock from a hidden trap into a stated product rule. It
is deliberately not a general inline mention parser: under D1 a mention anywhere
other than the first message of a conversation cannot change anything, so parsing
one would promise a capability the runtime does not have.

## Out of scope

- Per-message agent routing, orchestrator and sub-agent execution (rejected in D1).
- Per-user entitlement to individual profiles (D5 records the assumption and names
  the enforcement point instead).
- Signing, provenance attestation and multi-approver release for packs. The supply
  chain stays integrity-verified and single-approver; approval is bound to a digest
  but does not prove origin.
- Pack version history, pinning and rollback beyond retaining the previous
  known-good artifact and registry revision.
- Physically separating business lines into distinct Foundry agent deployments (T4).
- Immutable per-generation capability roots with atomic swap, dependency
  installation for packs, reference-counted blob collection and retention quotas.
  These are hardening, recorded so the smaller measures in scope are not mistaken
  for them.

## Revision history

| Revision | Date | Change |
| --- | --- | --- |
| 1 | 2026-08-24 | Initial design: four decisions, layered credential position, unified capability pack. |
| 2 | 2026-08-24 | Revised after plan review. Added D5 and fail-closed resolution; made the server the authority on the effective profile; replaced the unimplementable UID split in T2 and turned T3 into a measured verdict; kept `mcp_servers` as names and moved credentials into a separate write-only document; replaced the runtime "pack" with typed capability artifacts and digest-bound activation; added configuration-plane obligations; made workspace containment unconditional and renamed it. |
