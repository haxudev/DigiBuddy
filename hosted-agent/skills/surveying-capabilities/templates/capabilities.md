---
task_slug: <short-lowercase-hyphenated>
mode: compact | full | recovery
brief_revision: 1
revision: 1
surveyed_at: <ISO-8601 timestamp>
status: draft | unresolved | resolved
---

# Capabilities: <task title>

## Resolution

| Capability | Provider | Readiness | Evidence | Fallback |
| --- | --- | --- | --- | --- |
| <one of the fourteen> | <named provider or none> | confirmed / assumed / GAP / resolved-manual / resolved-substitute / resolved-drop | <observation and timestamp> | <confirmed fallback or agreed handling> |

`assumed` and `GAP` keep this artifact unresolved. Manual, substitute, and drop
are resolved only with the user's decision recorded below.

## Gap decisions

| Capability | Decision | User approval | Effect on result |
| --- | --- | --- | --- |
| <capability> | manual / substitute / drop | <ISO-8601 timestamp and decision> | <coverage or accuracy effect> |

## Compact eligibility

- [ ] Every provider was already confirmed ready without user action.
- [ ] No login, installation, permission, quota, or gap decision is needed.

If either check fails, mode is `full`.
