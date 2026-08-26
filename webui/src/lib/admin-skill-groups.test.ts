import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAssignableCapabilities,
  buildAdminSkillGroups,
  skillToggleRoute,
} from "./admin-skill-groups.ts";

test("admin skill groups show every packaged inventory entry", () => {
  const groups = buildAdminSkillGroups(
    [
      {
        name: "research",
        description: "Find sources.",
        source: "packaged",
        enabled: true,
      },
      {
        name: "pptx",
        description: "Make decks.",
        source: "packaged",
        enabled: false,
      },
      {
        name: "legacy",
        description: "An older runtime did not report origin.",
        source: "",
        enabled: true,
      },
    ],
    [],
    ["pptx"],
  );

  assert.deepEqual(
    groups.packaged.map((entry) => [entry.name, entry.enabled, entry.toggleRoute]),
    [
      ["pptx", false, "/api/admin/skill-policy"],
      ["research", true, "/api/admin/skill-policy"],
    ],
  );
  assert.deepEqual(groups.counts, {
    packaged: 2,
    packagedOff: 1,
    custom: 0,
    customOff: 0,
  });
});

test("admin skill groups route uploaded skills through the registry", () => {
  const groups = buildAdminSkillGroups(
    [{ name: "pptx", description: "Make decks.", source: "packaged", enabled: true }],
    [
      { name: "custom-off", description: "Paused.", enabled: false, version: "2" },
      { name: "custom-on", description: "Live.", enabled: true, version: "1" },
    ],
    [],
  );

  assert.deepEqual(
    groups.custom.map((entry) => [entry.name, entry.enabled, entry.toggleRoute]),
    [
      ["custom-off", false, "/api/admin/skills"],
      ["custom-on", true, "/api/admin/skills"],
    ],
  );
  assert.equal(groups.counts.custom, 2);
  assert.equal(groups.counts.customOff, 1);
});

test("skill toggle routes keep packaged and uploaded switches separate", () => {
  assert.equal(skillToggleRoute("packaged"), "/api/admin/skill-policy");
  assert.equal(skillToggleRoute("deployed"), "/api/admin/skills");
});

test("assignable capabilities stay in their own namespaces", () => {
  const assignable = buildAssignableCapabilities(
    {
      skills: ["packaged-skill"],
      tools: ["packaged_tool"],
      mcp_servers: ["learn"],
    },
    [
      {
        name: "custom-skill",
        kind: "skill",
        enabled: true,
        sha256: "a",
        approved_sha256: "",
      },
      {
        name: "custom_tool",
        kind: "tool",
        enabled: true,
        sha256: "b",
        approved_sha256: "b",
      },
      {
        name: "custom-mcp",
        kind: "mcp_server",
        enabled: true,
        sha256: "c",
        approved_sha256: "c",
      },
    ],
  );

  assert.deepEqual(assignable.skills, ["custom-skill", "packaged-skill"]);
  assert.deepEqual(assignable.tools, ["custom_tool", "packaged_tool"]);
  assert.deepEqual(assignable.mcp_servers, ["custom-mcp", "learn"]);
});

test("unapproved or disabled executable capabilities are not assignable", () => {
  const assignable = buildAssignableCapabilities(
    { skills: [], tools: [], mcp_servers: [] },
    [
      {
        name: "unapproved_tool",
        kind: "tool",
        enabled: true,
        sha256: "a",
        approved_sha256: "",
      },
      {
        name: "disabled-mcp",
        kind: "mcp_server",
        enabled: false,
        sha256: "b",
        approved_sha256: "b",
      },
    ],
  );

  assert.deepEqual(assignable, { skills: [], tools: [], mcp_servers: [] });
});

test("a packaged row says why it is missing from the chat menu", () => {
  // A built-in skill is enabled and working while never appearing as a `/`
  // command. Without the marker the console would show it as ordinary and
  // leave the absent menu row looking like a fault.
  const groups = buildAdminSkillGroups(
    [
      {
        name: "pptx",
        description: "Make decks.",
        source: "packaged",
        enabled: true,
        availability: "builtin",
      },
      {
        name: "acr-analysis",
        description: "Analyse revenue.",
        source: "packaged",
        enabled: true,
      },
    ],
    [],
    [],
  );

  assert.deepEqual(
    groups.packaged.map((entry) => [entry.name, entry.availability]),
    [
      ["acr-analysis", ""],
      ["pptx", "builtin"],
    ],
  );
});
