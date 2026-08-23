# Hosted Agent Release Automation Design

## Goal

Provide one repeatable command for routine DigiBuddy releases. The command must
validate the self-contained skill bundle, publish immutable Hosted Agent and
Web UI images, create a correctly shaped Foundry Agent version, update the Web
App, and prove both deployed surfaces work.

## Approach

Add a dependency-free Python orchestrator at
`scripts/release-hosted-agent.py`. Python owns JSON parsing, REST requests,
timeouts, redaction, and rollback; it invokes the existing `git`, `docker`, and
`az` CLIs for source state, local image validation, authentication, and ACR
builds. The script uses the Foundry v1 REST API directly because the installed
preview Azure CLI creates an incompatible Hosted Agent definition.

Safe mode is the default:

1. Require a clean, committed worktree and required executables.
2. Run skill drift detection, Hosted Agent tests, and an MCP probe that calls
   `maturity_get_question`.
3. Build and start the production image locally, then verify readiness, Node
   22, and bundled maturity assets.
4. Build the same commit in ACR under an immutable `<short-sha>-<utc-time>` tag
   and resolve its digest.
5. Copy the latest valid active Hosted Agent definition, replacing only the
   image, then create a new version through Foundry REST.
6. Wait for `active`, invoke the agent-specific Responses endpoint, and require
   an answer containing the known `A1.qa` maturity question.
7. Build `webui/Dockerfile` in ACR with the same immutable release tag, update
   `haeronclaw-haxu` while preserving app settings, and wait for HTTP 200.
8. Write both image digests, Agent version, Web App host, and response ID to a
   non-secret receipt under `.azure/releases/`.

`--fast` skips the local Docker build but keeps tests and online verification.
`--build-only` stops after both ACR digests are resolved. `--skip-webui` is
available for an intentional Agent-only release. Resource names and timeout are
overridable CLI options with repository-specific defaults.

## Safety and Failure Handling

- Never print environment-variable values, access tokens, or model keys.
- Reject dirty worktrees by default so the ACR tag identifies exact source.
- Select a source definition only when it is active, hosted, and contains an
  image plus Responses protocol.
- Bound every cloud wait with a timeout and report the failed stage.
- If online verification fails after creating a version, delete only that new
  version. If an active session prevents deletion, report the exact version for
  later cleanup rather than touching any older version.
- Update the Web App only after the Agent gate passes. If Web UI readiness
  fails, restore its previous image and restart it.
- Preserve the previous valid versions as rollback history.

## Testing

Unit tests cover command construction, valid-version selection, response text
extraction, redaction-safe receipts, and failure rollback decisions without
calling Azure. Existing Hosted Agent and MCP tests remain release gates. The
real release command supplies the end-to-end ACR, Foundry, and Responses checks.
