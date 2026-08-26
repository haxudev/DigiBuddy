import assert from "node:assert/strict";
import test from "node:test";

import type { Catalogue } from "./admin-config.ts";
import {
  BUILTIN_COMMANDS,
  MAX_COMMANDS,
  MAX_COMMAND_SKILLS,
  commandQuery,
  commandSkills,
  exceedsSkillLimit,
  isCommandSelected,
  leadingCommand,
  matchCommands,
  normaliseCommands,
  resolveCommand,
  resolveCommands,
  stripCommand,
  titleFromName,
  toggleCommand,
  type SkillCommand,
} from "./skill-commands.ts";

function catalogue(
  skills: Array<[name: string, description: string]>,
): Catalogue {
  return {
    skills: skills.map(([name]) => name),
    tools: [],
    mcp_servers: [],
    skill_entries: skills.map(([name, description]) => ({
      name,
      description,
      source: "packaged" as const,
      enabled: true,
    })),
  };
}

const CATALOGUE = catalogue([
  ["agent-maturity-assess", "Run a maturity assessment."],
  ["agent-maturity-report", "Re-render a scored assessment."],
  ["pptx", "Make slide decks."],
  ["skill-creator", "Build other skills."],
]);

const ALL = CATALOGUE.skills;

function command(name: string, title = name): SkillCommand {
  return {
    name,
    title,
    description: "",
    skills: [name],
    hint: "",
    enabled: true,
    order: 0,
  };
}

// --- Parsing the composer --------------------------------------------------

test("a leading slash opens the menu", () => {
  assert.deepEqual(commandQuery("/"), { query: "" });
  assert.deepEqual(commandQuery("/pptx"), { query: "pptx" });
  assert.deepEqual(commandQuery("  /agent"), { query: "agent" });
});

test("a slash in prose is not a command", () => {
  // Paths and dates are the common case, and treating one as a command would
  // hijack an ordinary message.
  assert.equal(commandQuery("see src/lib/thing.ts"), null);
  assert.equal(commandQuery("due 12/25"), null);
  assert.equal(commandQuery("and/or"), null);
});

test("a trailing space ends the command", () => {
  assert.equal(commandQuery("/pptx "), null);
});

test("leadingCommand splits the command from the message", () => {
  assert.deepEqual(leadingCommand("/pptx build a deck"), {
    query: "pptx",
    message: "build a deck",
  });
  assert.deepEqual(leadingCommand("/pptx"), { query: "pptx", message: "" });
  assert.equal(leadingCommand("no command here"), null);
});

test("stripCommand leaves the message the user wrote", () => {
  assert.equal(stripCommand("/pptx build a deck"), "build a deck");
  assert.equal(stripCommand("/pptx"), "");
});

// --- Matching and resolving ------------------------------------------------

const COMMANDS = [
  command("agent-adoption-assessment", "Agent Adoption Assessment"),
  command("agent-maturity-report", "Agent Maturity Report"),
  command("pptx", "Pptx"),
];

test("an exact name outranks a prefix", () => {
  assert.equal(matchCommands(COMMANDS, "pptx")[0].name, "pptx");
});

test("matching works on the title a reader actually sees", () => {
  assert.deepEqual(
    matchCommands(COMMANDS, "agent adoption").map((entry) => entry.name),
    ["agent-adoption-assessment"],
  );
});

test("an empty query offers everything", () => {
  assert.equal(matchCommands(COMMANDS, "").length, COMMANDS.length);
});

test("an ambiguous query resolves to nothing rather than a guess", () => {
  // Running a different skill than the one asked for is worse than saying so.
  assert.equal(resolveCommand(COMMANDS, "agent"), null);
});

test("an exact name resolves even when it is also a prefix", () => {
  const commands = [command("report"), command("report-writer")];
  assert.equal(resolveCommand(commands, "report")?.name, "report");
});

test("an unknown command resolves to nothing", () => {
  assert.equal(resolveCommand(COMMANDS, "nonsense"), null);
});

// --- Building the menu -----------------------------------------------------

test("every reachable skill becomes a command", () => {
  // A newly deployed skill is usable the moment it installs, without anyone
  // writing an entry for it.
  const commands = resolveCommands(CATALOGUE, [], ALL);
  assert.ok(commands.some((entry) => entry.name === "pptx"));
});

test("a discovered command carries the skill's own description", () => {
  const commands = resolveCommands(CATALOGUE, [], ALL);
  const pptx = commands.find((entry) => entry.name === "pptx");
  assert.equal(pptx?.description, "Make slide decks.");
});

test("a skill the profile cannot reach is not offered", () => {
  const commands = resolveCommands(CATALOGUE, [], ["pptx"]);
  assert.deepEqual(
    commands.map((entry) => entry.name),
    ["pptx"],
  );
});

test("the built-in assessment command is published by default", () => {
  // The store starts empty, and a console that offered nothing until someone
  // seeded it would look broken on a fresh deployment.
  const commands = resolveCommands(CATALOGUE, [], ALL);
  const assessment = commands.find(
    (entry) => entry.name === "agent-adoption-assessment",
  );
  assert.ok(assessment);
  assert.deepEqual(assessment.skills, [
    "agent-maturity-assess",
    "agent-maturity-report",
  ]);
});

test("the built-in command vanishes when its skills are not published", () => {
  const commands = resolveCommands(catalogue([["pptx", ""]]), [], ["pptx"]);
  assert.equal(
    commands.find((entry) => entry.name === "agent-adoption-assessment"),
    undefined,
  );
});

test("a partly reachable bundle degrades to the reachable part", () => {
  // Running the interview without the write-up is still worth offering.
  const commands = resolveCommands(CATALOGUE, [], ["agent-maturity-assess"]);
  const assessment = commands.find(
    (entry) => entry.name === "agent-adoption-assessment",
  );
  assert.deepEqual(assessment?.skills, ["agent-maturity-assess"]);
});

test("an override renames and redescribes a discovered command", () => {
  const commands = resolveCommands(
    CATALOGUE,
    [{ name: "pptx", title: "Slide Decks", description: "Build a deck." }],
    ALL,
  );
  const pptx = commands.find((entry) => entry.name === "pptx");
  assert.equal(pptx?.title, "Slide Decks");
  assert.equal(pptx?.description, "Build a deck.");
});

test("an override can hide a skill that has no business in a chat menu", () => {
  const commands = resolveCommands(
    CATALOGUE,
    [{ name: "skill-creator", enabled: false }],
    ALL,
  );
  assert.equal(
    commands.find((entry) => entry.name === "skill-creator"),
    undefined,
  );
});

test("an override can bundle several skills under one name", () => {
  const commands = resolveCommands(
    CATALOGUE,
    [
      {
        name: "maturity",
        title: "Maturity",
        skills: ["agent-maturity-assess", "agent-maturity-report"],
      },
    ],
    ALL,
  );
  const bundled = commands.find((entry) => entry.name === "maturity");
  assert.deepEqual(bundled?.skills, [
    "agent-maturity-assess",
    "agent-maturity-report",
  ]);
});

test("curated commands sort ahead of discovered ones", () => {
  const commands = resolveCommands(CATALOGUE, [], ALL);
  assert.equal(commands[0].name, "agent-adoption-assessment");
});

test("order decides among curated commands", () => {
  const commands = resolveCommands(
    CATALOGUE,
    [{ name: "pptx", order: -1 }],
    ALL,
  );
  assert.equal(commands[0].name, "pptx");
});

test("a stored override wins when it duplicates a built-in command", () => {
  const commands = resolveCommands(
    CATALOGUE,
    [
      {
        name: "agent-adoption-assessment",
        title: "Custom Assessment",
        skills: ["agent-maturity-report"],
      },
    ],
    ALL,
  );
  const assessment = commands.find(
    (entry) => entry.name === "agent-adoption-assessment",
  );

  assert.equal(assessment?.title, "Custom Assessment");
  assert.deepEqual(assessment?.skills, ["agent-maturity-report"]);
});

test("an explicit empty skill list drops a command instead of inheriting", () => {
  const commands = resolveCommands(
    CATALOGUE,
    [{ name: "pptx", skills: [] }],
    ALL,
  );

  assert.equal(commands.find((entry) => entry.name === "pptx"), undefined);
});

test("an absent skill list inherits the discovered command", () => {
  const commands = resolveCommands(CATALOGUE, [{ name: "pptx" }], ALL);
  const pptx = commands.find((entry) => entry.name === "pptx");

  assert.deepEqual(pptx?.skills, ["pptx"]);
});

test("the resolved command menu is capped after sorting", () => {
  const skills = Array.from({ length: MAX_COMMANDS + 20 }, (_, index) => [
    `skill-${String(index).padStart(3, "0")}`,
    "",
  ] as [string, string]);
  const commands = resolveCommands(catalogue(skills), [], skills.map(([name]) => name));

  assert.equal(commands.length, MAX_COMMANDS);
});

// --- Reading the document --------------------------------------------------

test("normaliseCommands keeps only usable entries", () => {
  const commands = normaliseCommands({
    commands: [
      { name: "good", title: "Good" },
      { name: "UPPER" },
      { name: "../escape" },
      { name: "" },
      "not an object",
      { title: "no name" },
    ],
  });
  assert.deepEqual(
    commands.map((entry) => entry.name),
    ["good", "upper"],
  );
});

test("normaliseCommands drops duplicate names", () => {
  const commands = normaliseCommands({
    commands: [
      { name: "dup", title: "First" },
      { name: "dup", title: "Second" },
    ],
  });
  assert.equal(commands.length, 1);
  assert.equal(commands[0].title, "First");
});

test("normaliseCommands rejects skill names that are not skill names", () => {
  const commands = normaliseCommands({
    commands: [{ name: "cmd", skills: ["fine", "../../escape", "also-fine"] }],
  });
  assert.deepEqual(commands[0].skills, ["fine", "also-fine"]);
});

test("normaliseCommands tolerates a missing or malformed document", () => {
  assert.deepEqual(normaliseCommands(null), []);
  assert.deepEqual(normaliseCommands({}), []);
  assert.deepEqual(normaliseCommands({ commands: "nope" }), []);
});

test("an absent field is left to the discovered value, not blanked", () => {
  // `title: ""` means "clear it"; no `title` key at all means "leave it".
  const commands = normaliseCommands({ commands: [{ name: "pptx" }] });
  assert.equal("title" in commands[0], false);
});

test("titleFromName makes a directory name readable", () => {
  assert.equal(titleFromName("agent-maturity-assess"), "Agent Maturity Assess");
  assert.equal(titleFromName("pptx"), "Pptx");
});

test("the built-in command list is well formed", () => {
  for (const entry of BUILTIN_COMMANDS) {
    assert.ok(entry.name.length > 0);
    assert.ok(entry.skills.length > 0);
    assert.ok(entry.title.length > 0);
  }
});

function armable(name: string, skills: string[]): SkillCommand {
  return {
    name,
    title: titleFromName(name),
    description: "",
    skills,
    hint: "",
    enabled: true,
    order: 0,
  };
}

test("choosing a command twice takes it back off", () => {
  const one = armable("one", ["a"]);
  const two = armable("two", ["b"]);

  const armed = toggleCommand(toggleCommand([], one), two);
  assert.deepEqual(
    armed.map((entry) => entry.name),
    ["one", "two"],
  );
  assert.equal(isCommandSelected(armed, "one"), true);

  const disarmed = toggleCommand(armed, one);
  assert.deepEqual(
    disarmed.map((entry) => entry.name),
    ["two"],
  );
  assert.equal(isCommandSelected(disarmed, "one"), false);
});

test("overlapping bundles load a shared skill once", () => {
  // Two curated commands may share a write-up skill. Naming it twice would say
  // the same thing twice in the turn's directive.
  const assess = armable("assess", ["interview", "report"]);
  const audit = armable("audit", ["scan", "report"]);

  assert.deepEqual(commandSkills([assess, audit]), [
    "interview",
    "report",
    "scan",
  ]);
});

test("a turn never asks for more skills than the runtime carries", () => {
  const big = armable(
    "big",
    Array.from({ length: MAX_COMMAND_SKILLS }, (_, index) => `skill-${index}`),
  );
  const extra = armable("extra", ["one-more"]);

  assert.equal(commandSkills([big]).length, MAX_COMMAND_SKILLS);
  // Refused before the fact, so the console can say why instead of the runtime
  // silently dropping the tail on arrival.
  assert.equal(exceedsSkillLimit([big], extra), true);
  assert.equal(commandSkills([big, extra]).length, MAX_COMMAND_SKILLS);
});

test("re-choosing an armed command is never over the limit", () => {
  const big = armable(
    "big",
    Array.from({ length: MAX_COMMAND_SKILLS }, (_, index) => `skill-${index}`),
  );

  // It is already counted, so removing it cannot make the turn too large.
  assert.equal(exceedsSkillLimit([big], big), false);
});
