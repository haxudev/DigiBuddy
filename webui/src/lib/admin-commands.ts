import {
  COMMANDS_DOCUMENT,
  ConfigValidationError,
  SCHEMA_FIELD,
  SCHEMA_VERSION,
  type ConfigStore,
  type JsonDocument,
} from "./admin-config.ts";
import {
  COMMAND_NAME,
  normaliseCommands,
  type CommandOverride,
} from "./skill-commands.ts";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function commandName(value: unknown): string {
  const name = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!COMMAND_NAME.test(name)) {
    throw new ConfigValidationError(
      `Command names may only contain lowercase letters, digits, dash and underscore: ${name}`,
    );
  }
  return name;
}

function document(commands: CommandOverride[]): JsonDocument {
  return { commands, [SCHEMA_FIELD]: SCHEMA_VERSION };
}

export async function readCommandsVersioned(
  store: ConfigStore,
): Promise<{ commands: CommandOverride[]; revision: string }> {
  const { document, revision } = await store.readVersioned(COMMANDS_DOCUMENT);
  return { commands: normaliseCommands(document), revision };
}

export async function writeCommands(
  store: ConfigStore,
  commands: CommandOverride[],
  expectedRevision?: string,
): Promise<CommandOverride[]> {
  const normalised = normaliseCommands({ commands });
  await store.write(COMMANDS_DOCUMENT, document(normalised), expectedRevision);
  return normalised;
}

export function commandPatch(input: unknown): CommandOverride {
  const raw = record(input);
  const patch = normaliseCommands({
    commands: [{ ...raw, name: commandName(raw.name) }],
  })[0];
  if (!patch) throw new ConfigValidationError("Command update is not valid.");
  return patch;
}

export function commandRevision(input: unknown): string | undefined {
  const revision = record(input).revision;
  return typeof revision === "string" ? revision : undefined;
}

export function upsertCommandOverride(
  commands: CommandOverride[],
  patch: CommandOverride,
): CommandOverride[] {
  const existing = commands.find((command) => command.name === patch.name);
  // A patch names only the fields the administrator touched, so it merges onto
  // what is stored rather than replacing it, and the entry keeps its place:
  // rewriting the document in a new order every time would turn a one-field
  // edit into a diff across the whole file.
  if (!existing) return [...commands, patch];
  return commands.map((command) =>
    command.name === patch.name ? { ...existing, ...patch } : command,
  );
}

export function removeCommandOverride(
  commands: CommandOverride[],
  name: unknown,
): { commands: CommandOverride[]; name: string } {
  const target = commandName(name);
  const next = commands.filter((command) => command.name !== target);
  if (next.length === commands.length) {
    throw new ConfigValidationError(`No override is configured for command: ${target}`);
  }
  return { commands: next, name: target };
}
