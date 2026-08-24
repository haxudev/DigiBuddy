# Architecture

## Runtime boundary

DigiBuddy is a Microsoft Foundry Hosted Agent with Codex app-server as its coding execution engine.

```text
Next.js / React Web UI
        │ AG-UI
        ▼
Next.js server proxy
        │ Responses protocol 2.0
        ▼
Microsoft Foundry Hosted Agent
        │
        ├── Responses adapter
        ├── response ↔ Codex thread mapping
        ├── profile assembly + config overlay
        └── Codex app-server
                ├── agent loop
                ├── shell / git / files
                └── /workspace
```

The Web UI also serves `/admin`, which writes the shared configuration store that the adapter reads at each turn boundary.

Foundry owns agent identity, authentication, lifecycle, scaling, isolation, and the external Responses API. Codex owns repository analysis, tool execution, file editing, and the coding-agent loop.

## Project structure

```text
azure.yaml                     # Foundry Hosted Agent deployment manifest
hosted-agent/
├── Dockerfile                 # Protocol 2.0 runtime image
├── main.py                    # Responses handler and stream adapter
└── codex_adapter/
    ├── client.py              # Codex stdio JSON-RPC client
    ├── config.py              # Runtime/model configuration and profile assembly
    ├── config_store.py        # Blob/file configuration overlay
    ├── profiles.py            # Agent profile parsing
    ├── events.py              # Codex event conversion
    └── session_map.py         # Response-to-thread persistence

webui/                         # Independent Next.js + React + AG-UI app
├── src/app/api/agent/route.ts # Server-side Foundry proxy
├── src/app/api/admin/config/  # Admin configuration API
├── src/app/api/profiles/      # Public profile list for the chat picker
├── src/app/admin/             # Admin console
├── src/lib/admin-config.ts    # Configuration schema and store clients
├── src/lib/admin-auth.ts      # Easy Auth administrator guard
├── src/lib/agent-proxy.ts     # Validation and response helpers
└── Dockerfile                 # Generic OCI / Web App for Containers image

src/                           # Agent payload: persona, skills, tools, mcp.json
├── AGENTS.md                  # Persona and capability catalogue
├── mcp.json                   # Remote/local MCP server catalogue
├── skills/                    # <name>/SKILL.md definitions
└── tools/                     # Python tools with CLI entry points
```

The `src/` tree is copied into the image at `/opt/digibuddy` and surfaced to Codex through `DIGIBUDDY_PAYLOAD_ROOT`, `DIGIBUDDY_SKILLS_ROOT`, and `DIGIBUDDY_TOOLS_ROOT`.

## Session and streaming flow

1. The browser sends AG-UI messages only to the same-origin `/api/agent` route.
2. The route validates the configured endpoint and invokes the Foundry Responses API.
3. Foundry forwards the request to the hosted container on port `8088`.
4. The adapter starts or resumes a Codex thread and streams Codex turn events.
5. The adapter emits Responses events; the web proxy converts them into AG-UI events.
6. `previous_response_id` preserves the conversation-to-Codex-thread relationship.

The response map is stored under the hosted session workspace so session resume does not depend on process memory.

## Configuration and security

- Model endpoint, API key, and model name are runtime environment variables, optionally overlaid by `models.json` in the shared configuration store.
- The generated Codex configuration references the key environment variable; it never embeds the secret.
- Codex defaults to `workspace-write` with approval policy `never`.
- The Web UI key remains server-side when supplied through container settings.
- The Web UI only permits approved HTTPS endpoint suffixes in production.
- `/admin` is guarded by an Entra allowlist over the Easy Auth principal header; the model key is write-only and every write is audited.
- Every configuration document declares `schema_version`. A runtime that meets a newer version keeps the last version it could read rather than reinterpreting the document, because the fields it would ignore are the ones a newer console added to restrict something.
- `profiles.json` and the capability registry are written conditionally and report a conflict rather than overwriting, because both are read-modify-write from two independent surfaces.
- An explicitly named profile that is not configured is an error. Falling back to the default would let a renamed or deleted restricted agent resume with the capabilities of a different one.

## Isolation and identity: what is measured

The claim this section used to make — that Foundry session isolation is the security boundary — was never verified. `scripts/probe_runtime_isolation.py` is what verifies it. Run it from two concurrent conversations, giving the first `--write-probe a`.

Measured on 2026-08-24 against the built image:

| Question | Method | Result |
| --- | --- | --- |
| Can a same-UID child read the adapter's environment through procfs? | `/proc/1/environ` from a Codex turn | Readable while the adapter is dumpable |
| Does making the adapter undumpable close that? | `prctl(PR_SET_DUMPABLE, 0)`, then re-read | Yes — the entry becomes root-owned and the child is refused |
| Can the adapter launch Codex under another UID? | `create_subprocess_exec(user=...)` as the unprivileged `agent` user | No — `PermissionError`, so the UID split first drafted is not available |
| Does one container serve one conversation? | boot id, cgroup and workspace cross-read | **Not yet measured in the deployed environment.** Record the outcome here when it is |

Two probes were deliberately rejected as evidence. `echo $$` reports the shell a command ran in, not the container. Watching whether a second conversation receives the first one's deliverable cannot fail: the second snapshots the workspace at its own turn start, by which time the earlier file is already in its baseline and can never be reported as changed.

Because a negative cross-read describes one scheduling outcome rather than a guarantee, workspace containment is unconditional and does not wait on this answer.

- Each conversation gets its own workspace, so artifacts are attributed correctly and nothing is read across conversations by accident. Two same-UID Codex processes can still read each other's directories, so this is containment, not isolation; isolation would require a process or container boundary per conversation.
- Profile skill and tool filtering curates what an agent is offered, and is not itself a sandbox.

## Credentials scoped to an agent

A profile binds credentials to named capability slots, and the runtime hands a Codex process only the bindings of the profile it is running. Because changing profile already replaces that process, one agent's secrets are never present in another's environment.

Three measures make that claim true rather than aspirational, and one limit makes it honest.

| Tier | What it does | Where |
| --- | --- | --- |
| T1 | The child environment is built from an explicit allowlist plus the active profile's bindings, instead of copying this process's environment | `hosted-agent/codex_adapter/config.py` |
| T2 | The adapter marks itself undumpable, so a same-UID child cannot read its `/proc` entry — where the model key and every resolved credential live | `hosted-agent/codex_adapter/hardening.py` |
| T3 | The configuration store URI is withheld from the child, so the address of every profile's secrets does not travel with it | `hosted-agent/codex_adapter/config.py` |
| T4 | Separate Foundry agent deployments, each with its own identity, store and RBAC | Not implemented; the escalation path |

Values live in `credentials.json`, which no read API returns: the console reports which slots are set and offers to rotate or clear one. Slots are a closed set, so a binding cannot shadow `PATH`, `PYTHONPATH` or the model key. The resolved values feed the runtime fingerprint through a per-process keyed digest, so rotating a secret under the same slot still replaces the Codex process, and no secret-derived digest leaves the process.

**The limit.** T1 through T3 stop an agent using a credential it was not granted. They do not stop a prompt injection asking the container's ambient managed identity for a token, because the adapter and Codex share one container identity — and withholding that identity from Codex would also break `src/tools/azure_blob.py`, which uses it deliberately to publish deliverables. A business line that cannot accept that residual risk needs T4, not a further tier here.

Logging is treated as a credential sink for the same reason. Turn events are logged by type, and Codex's stderr by length rather than content, because a tool that prints a token would otherwise persist it in centralised logs long after the profile it belonged to was rotated.

## Configuration overlay and profiles

`config_store.py` reads five documents — `models.json`, `mcp.json`, `profiles.json`, `skills.json`, and `catalogue.json` — from Azure Blob (`DIGIBUDDY_CONFIG_URI`) or a directory (`DIGIBUDDY_CONFIG_DIR`), behind a short TTL cache. The same private store carries generated deliverables below `artifacts/<random-id>/`; the Web UI exposes only validated same-origin artifact routes.

At each turn boundary the adapter re-reads the overlay, resolves the requested profile from `metadata.profile`, and fingerprints the resulting model settings and profile. A changed fingerprint restarts the Codex engine, so administrative changes apply without a redeploy. A restricted profile gets a filtered view of the payload, with `DIGIBUDDY_SKILLS_ROOT` and `DIGIBUDDY_TOOLS_ROOT` pointed at it.

At startup the runtime publishes `catalogue.json`, describing the skills, tools, and MCP servers the image actually ships, so the admin console cannot drift from the deployed image.

## Skills plane

An agent's most useful capabilities arrive faster than the image does, so skills have a second, centralised source alongside the ones baked into `src/skills/`.

An administrator uploads a skill bundle — a zip with `SKILL.md` at its root — through the admin console. The console validates the archive, hashes it, and stores it in the **same blob container as the configuration documents**, at `bundles/<name>/<sha256>.zip`. This deliberately adds no Azure service: the container and its managed identity already exist. The `skills.json` registry then names the bundle, and because the console always derives that path from the name and digest, an entry can never point at another blob.

Real skill projects are rarely that tidy: a repository archive carries several skills, a shared Python package and helper scripts. The console therefore **explodes** such an archive into one self-contained single-skill bundle each — vendoring the shared code under the skill and generating an entrypoint that puts it on `sys.path` — optionally driven by a `digibuddy-skills.json` manifest in the archive, and otherwise inferred from its layout. The runtime is unchanged by this: it still only ever sees the simple case, one skill per content-addressed bundle. An archive may also be fetched from a URL, but only from a host on the `SKILL_IMPORT_ALLOWED_HOSTS` allowlist, over HTTPS, with redirects re-validated per hop and private addresses refused; the network is never in the trust path, because what the agent installs is whatever the store holds under the digest the console recorded. Because one archive can create and replace several skills at once, deployment is confirmed against a dry-run preview that writes nothing.

Each hosted agent, at the same turn boundary where it re-reads the overlay, installs the enabled skills its profile allows into `$CODEX_HOME/skills` — the only global skills root the Foundry container leaves intact. It re-verifies the SHA-256 and re-checks every archive member, because the store, not the console, is the trust boundary. Extraction is staged and renamed, so a rejected bundle never leaves a half-installed skill, and one broken bundle does not stop the healthy ones.

Packaged skills win: an upload that shares a name with a reviewed, image-baked skill is refused rather than allowed to shadow it. The deployed set feeds `runtime_fingerprint`, so deploying, disabling or withdrawing a skill replaces the Codex process instead of silently serving a stale one.

## Agent payload

The Codex sandbox has no tool registry — only a shell. Capabilities are therefore delivered as files:

- **Persona**: `src/AGENTS.md` is concatenated with the hosted-agent guardrails in `hosted-agent/AGENTS.md` to form the Codex base instructions.
- **Tools**: each module under `src/tools/` exposes an `argparse` CLI and is invoked as `python -m <tool>`.
- **Skills**: each `src/skills/<name>/SKILL.md` is read on demand by the agent.
- **MCP**: `src/mcp.json` is rendered into `[mcp_servers.*]` blocks in the generated Codex `config.toml`.
