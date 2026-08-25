import assert from "node:assert/strict";
import test from "node:test";

import type { JsonDocument } from "./admin-config.ts";
import { resolveUserCommands } from "./user-commands.ts";

function catalogue(skills: string[]): JsonDocument {
  return {
    skills,
    tools: [],
    mcp_servers: [],
    skill_entries: skills.map((name) => ({
      name,
      description: `${name} description`,
      source: "packaged",
      enabled: true,
    })),
  };
}

const WITH_ASSESSMENT = catalogue([
  "agent-maturity-assess",
  "agent-maturity-report",
  "pptx",
  "research",
]);

test("a named profile restricts slash commands to that profile's skills", () => {
  const commands = resolveUserCommands(
    WITH_ASSESSMENT,
    null,
    { profiles: [{ name: "slides", skills: ["pptx"] }] },
    null,
    "slides",
  );

  assert.deepEqual(commands.map((command) => command.name), ["pptx"]);
});

test("a profile name no profile answers to gets nothing", () => {
  // Falling back to the whole catalogue here would make `?profile=anything`
  // the most permissive answer the endpoint can give, listing every skill the
  // deployment ships in a deployment whose every profile is restricted.
  const commands = resolveUserCommands(
    WITH_ASSESSMENT,
    null,
    { profiles: [{ name: "slides", skills: ["pptx"] }] },
    null,
    "missing",
  );

  assert.deepEqual(commands, []);
});

test("an absent profile name uses the configured default profile", () => {
  const commands = resolveUserCommands(
    WITH_ASSESSMENT,
    null,
    { profiles: [{ name: "digibuddy", skills: ["pptx"] }] },
    null,
    "",
  );

  assert.deepEqual(commands.map((command) => command.name), ["pptx"]);
});

test("an absent profile name fails closed when configured profiles omit the default", () => {
  const commands = resolveUserCommands(
    WITH_ASSESSMENT,
    null,
    { profiles: [{ name: "slides", skills: ["pptx"] }] },
    null,
    "",
  );

  assert.deepEqual(commands, []);
});

test("no profiles document keeps the unrestricted built-in default", () => {
  const commands = resolveUserCommands(WITH_ASSESSMENT, null, null, null, "");

  assert.ok(commands.some((command) => command.name === "pptx"));
  assert.ok(commands.some((command) => command.name === "research"));
});

test("an unseeded command store still publishes reachable built-ins", () => {
  const commands = resolveUserCommands(WITH_ASSESSMENT, null, null, null, "");
  const assessment = commands.find(
    (command) => command.name === "agent-adoption-assessment",
  );

  assert.deepEqual(assessment?.skills, [
    "agent-maturity-assess",
    "agent-maturity-report",
  ]);
});

test("an unseeded command store drops built-ins whose skills are missing", () => {
  const commands = resolveUserCommands(catalogue(["pptx"]), null, null, null, "");

  assert.equal(
    commands.find((command) => command.name === "agent-adoption-assessment"),
    undefined,
  );
});

test("stored overrides are applied on top of auto-discovery", () => {
  const commands = resolveUserCommands(
    WITH_ASSESSMENT,
    { commands: [{ name: "pptx", title: "Slide Decks", hint: "bring notes" }] },
    null,
    null,
    "",
  );
  const pptx = commands.find((command) => command.name === "pptx");

  assert.equal(pptx?.title, "Slide Decks");
  assert.equal(pptx?.hint, "bring notes");
});

test("a profile with an explicit empty skill list has no commands", () => {
  const commands = resolveUserCommands(
    WITH_ASSESSMENT,
    null,
    { profiles: [{ name: "empty", skills: [] }] },
    null,
    "empty",
  );

  assert.deepEqual(commands, []);
});

test("an override cannot reintroduce a skill outside the active profile", () => {
  const commands = resolveUserCommands(
    WITH_ASSESSMENT,
    { commands: [{ name: "research", title: "Curated Research" }] },
    { profiles: [{ name: "slides", skills: ["pptx"] }] },
    null,
    "slides",
  );

  assert.equal(commands.find((command) => command.name === "research"), undefined);
});
