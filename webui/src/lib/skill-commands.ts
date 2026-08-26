/**
 * Loading a skill with `/`.
 *
 * The sibling of `mentions.ts`, and deliberately not the same rule. A mention
 * picks the agent, and Codex fixes a thread's base instructions when the thread
 * starts, so `@` is only meaningful in the first message of an unbound
 * conversation. A skill is markdown the model reads on demand, so `/` stays
 * meaningful for the whole conversation and applies to one message at a time.
 *
 * What the menu offers is the catalogue the runtime published, filtered to what
 * the active profile can reach and to what the runtime says belongs in a menu,
 * with a curated layer over the top.
 *
 * Most skills do not belong here. `pptx` and `html-report` are things the agent
 * reaches for the moment a request needs them, and asking a user to type
 * `/pptx` before they may have a deck is asking them to know the
 * implementation; the maturity sub-skills are implementation behind one curated
 * command. The runtime says which is which through `availability`, and only
 * `command` — or an older runtime's silence — becomes a menu row.
 */

import type { Catalogue, CatalogueSkill } from "./admin-config.ts";

/** A skill directory name, matching the registry and the runtime. */
export const COMMAND_NAME = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

/** Only a leading `/word`, so a path or a date in prose is never a command. */
const LEADING_COMMAND = /^\/([a-z0-9][\w-]*)?$/i;
const LEADING_COMMAND_MESSAGE = /^\s*\/([a-z0-9][\w-]*)(?:\s+([\s\S]*))?$/i;

/** How many skills one command may load, mirroring the runtime's own ceiling. */
export const MAX_COMMAND_SKILLS = 8;

/** A chat menu should stay a menu, even if the stored document is generated. */
export const MAX_COMMANDS = 100;

/**
 * A published command.
 *
 * `skills` is what the turn actually loads. It is usually the one skill the
 * command is named after, but a command may bundle a few: an assessment is run
 * by one skill and written up by another, and the user should not have to know
 * that.
 */
export type SkillCommand = {
  name: string;
  title: string;
  description: string;
  skills: string[];
  /** Shown under the composer once the command is chosen. */
  hint: string;
  enabled: boolean;
  /** Lower sorts first; equal values fall back to the title. */
  order: number;
};

/** What an administrator may say about a command, all of it optional. */
export type CommandOverride = Partial<Omit<SkillCommand, "name">> & { name: string };

export type CommandsDocument = { commands: CommandOverride[] };

/**
 * Commands that exist before an administrator has configured anything.
 *
 * The store starts empty, and a console that offered nothing until someone
 * seeded it would look broken on a fresh deployment. This mirrors
 * `defaultProfileCapabilities`, which exists for the same reason. An entry here
 * is still only an offer: it appears when the runtime actually publishes the
 * skills it names, and vanishes when it does not.
 */
export const BUILTIN_COMMANDS: SkillCommand[] = [
  {
    name: "agent-adoption-assessment",
    title: "Agent Adoption Assessment",
    description:
      "Run a Microsoft Agentic AI adoption maturity assessment as a consulting " +
      "interview, score it honestly, and produce an interactive HTML report with " +
      "a maturity radar chart.",
    // Two skills, because the work has two halves and the second one is the
    // part a customer actually reads.
    skills: ["agent-maturity-assess", "agent-maturity-report"],
    hint: "Optionally name the organisation and depth, e.g. Contoso, pulse",
    enabled: true,
    order: 0,
  },
];

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Turn a directory name into something worth reading in a menu. */
export function titleFromName(name: string): string {
  return name
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** Parse the `commands.json` document, skipping entries that say nothing usable. */
export function normaliseCommands(input: unknown): CommandOverride[] {
  const raw =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>).commands
      : null;
  if (!Array.isArray(raw)) return [];

  const seen = new Set<string>();
  const commands: CommandOverride[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    const name = text(entry.name).toLowerCase();
    if (!COMMAND_NAME.test(name) || seen.has(name)) continue;
    seen.add(name);

    const override: CommandOverride = { name };
    if (typeof entry.title === "string") override.title = text(entry.title);
    if (typeof entry.description === "string") {
      override.description = text(entry.description);
    }
    if (typeof entry.hint === "string") override.hint = text(entry.hint);
    if (typeof entry.enabled === "boolean") override.enabled = entry.enabled;
    if (typeof entry.order === "number" && Number.isFinite(entry.order)) {
      override.order = entry.order;
    }
    if (Array.isArray(entry.skills)) {
      const skills = entry.skills
        .map((skill) => text(skill).toLowerCase())
        .filter(
          (skill, index, all) =>
            COMMAND_NAME.test(skill) && all.indexOf(skill) === index,
        )
        .slice(0, MAX_COMMAND_SKILLS);
      override.skills = skills;
    }
    commands.push(override);
  }
  return commands;
}

/**
 * The commands a user may run, given what the runtime published and what the
 * profile allows.
 *
 * Every reachable skill the runtime marks as belonging in a menu becomes a
 * command, so a newly deployed skill is usable the moment it installs, without
 * an administrator writing an entry for it. Overrides then rename, redescribe,
 * reorder, bundle or hide — and an override may still name a `builtin` or
 * `hidden` skill, because an administrator asking for a menu row knows better
 * than the default.
 *
 * A command is dropped when the skills it names are not reachable, rather than
 * shown and then failing: the runtime enforces the profile independently, so an
 * entry the profile forbids would be a menu row that does nothing.
 */
export function resolveCommands(
  catalogue: Catalogue,
  overrides: CommandOverride[],
  allowedSkills: string[],
): SkillCommand[] {
  const allowed = new Set(allowedSkills);
  const described = new Map<string, CatalogueSkill>(
    catalogue.skill_entries.map((entry) => [entry.name, entry]),
  );

  const commands = new Map<string, SkillCommand>();
  for (const name of catalogue.skills) {
    if (!allowed.has(name)) continue;
    const entry = described.get(name);
    // An empty availability is an older runtime that does not publish the
    // field. Reading it as `command` keeps the menu it used to show, rather
    // than emptying the menu the moment the console rolls out first.
    const availability = entry?.availability ?? "";
    if (availability !== "command" && availability !== "") continue;
    commands.set(name, {
      name,
      title: titleFromName(name),
      description: entry?.description ?? "",
      skills: [name],
      hint: "",
      enabled: true,
      // Discovered commands sort after curated ones, which carry an explicit
      // order and are the ones an administrator wanted seen first.
      order: 100,
    });
  }

  for (const override of [...BUILTIN_COMMANDS, ...overrides]) {
    const base = commands.get(override.name);
    const declared = override.skills ?? base?.skills ?? [override.name];
    // A curated command is only as real as the skills behind it. Where a
    // bundle is partly reachable it degrades to the reachable part -- running
    // the interview without the write-up is still worth offering -- but a
    // command with nothing left behind it is not a command.
    const skills = declared.filter((skill) => allowed.has(skill));
    if (!skills.length) {
      commands.delete(override.name);
      continue;
    }
    commands.set(override.name, {
      name: override.name,
      title: override.title || base?.title || titleFromName(override.name),
      description:
        override.description ??
        base?.description ??
        described.get(skills[0])?.description ??
        "",
      skills,
      hint: override.hint ?? base?.hint ?? "",
      enabled: override.enabled ?? base?.enabled ?? true,
      order: override.order ?? base?.order ?? 0,
    });
  }

  return [...commands.values()]
    .filter((command) => command.enabled)
    .sort((left, right) => left.order - right.order || left.title.localeCompare(right.title))
    .slice(0, MAX_COMMANDS);
}

export type CommandQuery = { query: string };

/** The command being typed, or `null` when this is ordinary prose. */
export function commandQuery(composer: string): CommandQuery | null {
  const match = LEADING_COMMAND.exec(composer.trimStart());
  if (!match) return null;
  // A trailing space ends the command: the user moved on to the message.
  if (composer.trimStart() !== composer.trim()) return null;
  return { query: (match[1] ?? "").toLowerCase() };
}

export type LeadingCommand = { query: string; message: string };

/** Parse `/command message` without treating a path in prose as a command. */
export function leadingCommand(composer: string): LeadingCommand | null {
  const match = LEADING_COMMAND_MESSAGE.exec(composer);
  if (!match) return null;
  return { query: match[1].toLowerCase(), message: (match[2] ?? "").trim() };
}

/**
 * Commands worth offering for a query, most relevant first.
 *
 * Matches the name and the title, because the reader sees the title and the
 * command is invoked by name.
 */
export function matchCommands(
  commands: SkillCommand[],
  query: string,
): SkillCommand[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...commands];
  const scored = commands
    .map((command) => {
      const name = command.name.toLowerCase();
      const title = command.title.toLowerCase();
      if (name === needle) return { command, rank: 0 };
      if (name.startsWith(needle) || title.startsWith(needle)) {
        return { command, rank: 1 };
      }
      if (name.includes(needle) || title.includes(needle)) {
        return { command, rank: 2 };
      }
      return null;
    })
    .filter((entry) => entry !== null);
  scored.sort(
    (left, right) => left.rank - right.rank || left.command.order - right.command.order,
  );
  return scored.map((entry) => entry.command);
}

/**
 * Resolve a typed command to exactly one entry.
 *
 * Ambiguity resolves to nothing rather than to a guess: silently running a
 * different skill than the one asked for is worse than saying so.
 */
export function resolveCommand(
  commands: SkillCommand[],
  query: string,
): SkillCommand | null {
  const matches = matchCommands(commands, query);
  if (matches.length === 0) return null;
  const needle = query.trim().toLowerCase();
  const exact = matches.find((command) => command.name.toLowerCase() === needle);
  if (exact) return exact;
  return matches.length === 1 ? matches[0] : null;
}

/** Remove the command token, leaving the message the user actually wrote. */
export function stripCommand(composer: string): string {
  return composer.replace(/^\s*\/[\w-]*\s*/, "");
}

/**
 * Add or remove a command from the set armed for the next message.
 *
 * A turn may load several skills -- the runtime's own ceiling is
 * `MAX_TURN_SKILLS`, and a curated command already bundles two or three -- so
 * the menu is a set rather than a single choice. Choosing an already-chosen
 * command takes it back off, because the same keystroke that armed it is the
 * obvious way to disarm it.
 */
export function toggleCommand(
  selected: SkillCommand[],
  entry: SkillCommand,
): SkillCommand[] {
  return selected.some((command) => command.name === entry.name)
    ? selected.filter((command) => command.name !== entry.name)
    : [...selected, entry];
}

export function isCommandSelected(
  selected: SkillCommand[],
  name: string,
): boolean {
  return selected.some((command) => command.name === name);
}

/**
 * The skills a set of commands actually loads, in the order they were chosen.
 *
 * Commands overlap -- two bundles may share a write-up skill -- so duplicates
 * collapse, and the result is capped at what one turn may carry. Truncating
 * here rather than at the boundary means the console can say so, instead of the
 * runtime silently dropping the tail.
 */
export function commandSkills(selected: SkillCommand[]): string[] {
  const skills: string[] = [];
  for (const command of selected) {
    for (const skill of command.skills) {
      if (skills.includes(skill)) continue;
      skills.push(skill);
      if (skills.length >= MAX_COMMAND_SKILLS) return skills;
    }
  }
  return skills;
}

/**
 * Whether adding this command would ask for more skills than a turn may carry.
 *
 * Asked before the fact, so the menu can refuse with a reason rather than
 * accepting a chip whose skills would then be dropped.
 */
export function exceedsSkillLimit(
  selected: SkillCommand[],
  entry: SkillCommand,
): boolean {
  if (isCommandSelected(selected, entry.name)) return false;
  const current = commandSkills(selected);
  const added = entry.skills.filter((skill) => !current.includes(skill));
  return current.length + added.length > MAX_COMMAND_SKILLS;
}
