import assert from "node:assert/strict";
import test from "node:test";

import type { ProfileDocument } from "./admin-config.ts";
import { describeProfiles } from "./profile-capabilities.ts";

function profile(overrides: Partial<ProfileDocument>): ProfileDocument {
  return {
    name: "builder",
    display_name: "Builder",
    description: "",
    persona: "",
    skills: null,
    tools: null,
    mcp_servers: null,
    model: "",
    reasoning_effort: "",
    ...overrides,
  };
}

const catalogue = {
  skills: ["research", "writing"],
  tools: ["shell"],
  mcp_servers: ["github", "stale"],
};

test("a null selection inherits the whole catalogue", () => {
  const [described] = describeProfiles([profile({})], catalogue, { servers: {} });
  assert.deepEqual(described.skills, ["research", "writing"]);
  assert.deepEqual(described.tools, ["shell"]);
});

test("a selection is restricted to catalogued entries", () => {
  const [described] = describeProfiles(
    [profile({ skills: ["research", "removed"] })],
    catalogue,
    { servers: {} },
  );
  assert.deepEqual(described.skills, ["research"]);
});

test("disabled MCP servers are not advertised as capabilities", () => {
  const [described] = describeProfiles([profile({})], catalogue, {
    servers: {
      github: { url: "https://a", enabled: true, bearer_token_env_var: "", description: "" },
      stale: { url: "https://b", enabled: false, bearer_token_env_var: "", description: "" },
    },
  });
  assert.deepEqual(described.mcp_servers, ["github"]);
});
