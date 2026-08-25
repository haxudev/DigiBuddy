import {
  ConfigValidationError,
  SCHEMA_FIELD,
  SCHEMA_VERSION,
  SKILL_POLICY_DOCUMENT,
  normaliseSkillPolicy,
  type ConfigStore,
  type JsonDocument,
} from "./admin-config.ts";
import { COMMAND_NAME } from "./skill-commands.ts";

export type SkillPolicyPatch = { name: string; enabled: boolean };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function skillName(value: unknown): string {
  const name = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!COMMAND_NAME.test(name)) {
    throw new ConfigValidationError(
      `Skill names may only contain lowercase letters, digits, dash and underscore: ${name}`,
    );
  }
  return name;
}

function document(disabled: string[]): JsonDocument {
  return { disabled, [SCHEMA_FIELD]: SCHEMA_VERSION };
}

export async function readSkillPolicyVersioned(
  store: ConfigStore,
): Promise<{ disabled: string[]; revision: string }> {
  const { document, revision } = await store.readVersioned(SKILL_POLICY_DOCUMENT);
  return { disabled: normaliseSkillPolicy(document).disabled, revision };
}

export async function writeSkillPolicy(
  store: ConfigStore,
  disabled: string[],
  expectedRevision?: string,
): Promise<string[]> {
  const normalised = normaliseSkillPolicy({ disabled }).disabled;
  await store.write(SKILL_POLICY_DOCUMENT, document(normalised), expectedRevision);
  return normalised;
}

export function skillPolicyRevision(input: unknown): string | undefined {
  const revision = record(input).revision;
  return typeof revision === "string" ? revision : undefined;
}

export function skillPolicyPatch(input: unknown): SkillPolicyPatch {
  const raw = record(input);
  if (typeof raw.enabled !== "boolean") {
    throw new ConfigValidationError("Skill policy updates need an enabled boolean.");
  }
  return { name: skillName(raw.name), enabled: raw.enabled };
}

export function toggleSkillPolicy(
  disabled: string[],
  patch: SkillPolicyPatch,
): string[] {
  const current = normaliseSkillPolicy({ disabled }).disabled;
  if (patch.enabled) return current.filter((name) => name !== patch.name);
  return current.includes(patch.name) ? current : [...current, patch.name];
}
