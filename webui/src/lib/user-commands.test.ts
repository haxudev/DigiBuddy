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

test("naming the built-in default means what omitting it means", () => {
  // The console always names it: the picker offers the fallback profile and
  // the runtime reports it back as the agent that ran, so `?profile=digibuddy`
  // is the ordinary case rather than an unknown name.
  const commands = resolveUserCommands(
    WITH_ASSESSMENT,
    null,
    null,
    null,
    "digibuddy",
  );

  assert.ok(commands.some((command) => command.name === "pptx"));
  assert.ok(commands.some((command) => command.name === "research"));
});

test("naming the deployment's configured default means what omitting it means", () => {
  const commands = resolveUserCommands(
    WITH_ASSESSMENT,
    null,
    null,
    null,
    "gtmbuddy",
    "gtmbuddy",
  );

  assert.ok(commands.some((command) => command.name === "pptx"));
});

test("an unknown name gets nothing even before profiles are configured", () => {
  const commands = resolveUserCommands(
    WITH_ASSESSMENT,
    null,
    null,
    null,
    "somebody-else",
  );

  assert.deepEqual(commands, []);
});

test("a configured profile still wins over the deployment default name", () => {
  // Once profiles exist, the default name is answered by the profile document,
  // not by the unrestricted fallback.
  const commands = resolveUserCommands(
    WITH_ASSESSMENT,
    null,
    { profiles: [{ name: "digibuddy", skills: ["pptx"] }] },
    null,
    "digibuddy",
  );

  assert.deepEqual(commands.map((command) => command.name), ["pptx"]);
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
