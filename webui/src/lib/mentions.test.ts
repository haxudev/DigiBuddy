import assert from "node:assert/strict";
import test from "node:test";

import {
  matchProfiles,
  mentionQuery,
  resolveMention,
  stripMention,
} from "./mentions.ts";
import type { ProfileCapabilities } from "./profile-capabilities.ts";

function profile(
  name: string,
  display_name = name,
): ProfileCapabilities {
  return {
    name,
    display_name,
    description: "",
    skills: [],
    tools: [],
    mcp_servers: [],
  };
}

const AGENTS = [
  profile("marketing", "Marketing Partner"),
  profile("marketing-ops", "Marketing Ops"),
  profile("support-desk", "Support Desk"),
];

test("a leading @ in an empty composer opens the list", () => {
  assert.deepEqual(mentionQuery("@"), { query: "" });
  assert.deepEqual(mentionQuery("@mark"), { query: "mark" });
  assert.deepEqual(mentionQuery("  @Mark"), { query: "mark" });
});

test("a mention anywhere else is just text", () => {
  // Under session-level binding it could not change anything, so treating it
  // as a control would promise something the runtime will not honour.
  assert.equal(mentionQuery("ask @marketing about this"), null);
  assert.equal(mentionQuery("email me @ 5pm"), null);
  assert.equal(mentionQuery("hello"), null);
  assert.equal(mentionQuery(""), null);
});

test("a trailing space ends the mention", () => {
  assert.equal(mentionQuery("@marketing "), null);
});

test("a partial query filters, preferring the closest match", () => {
  const matches = matchProfiles(AGENTS, "mark");

  assert.deepEqual(
    matches.map((entry) => entry.name),
    ["marketing", "marketing-ops"],
  );
});

test("the display name is searchable, because it is what the reader sees", () => {
  // The reader sees "Support Desk"; the runtime only accepts "support-desk".
  assert.deepEqual(
    matchProfiles(AGENTS, "support d").map((entry) => entry.name),
    ["support-desk"],
  );
  assert.deepEqual(
    matchProfiles(AGENTS, "partner").map((entry) => entry.name),
    ["marketing"],
  );
});

test("an empty query offers every agent", () => {
  assert.equal(matchProfiles(AGENTS, "").length, 3);
});

test("a mention resolves to exactly one agent or to none", () => {
  assert.equal(resolveMention(AGENTS, "support-desk")?.name, "support-desk");
  assert.equal(resolveMention(AGENTS, "support")?.name, "support-desk");
  // "mark" matches two, so it resolves to nothing rather than guessing which
  // agent -- and which credentials -- the conversation should get.
  assert.equal(resolveMention(AGENTS, "mark"), null);
  assert.equal(resolveMention(AGENTS, "nobody"), null);
});

test("an exact name wins over a longer one that also matches", () => {
  assert.equal(resolveMention(AGENTS, "marketing")?.name, "marketing");
});

test("the token never reaches the agent", () => {
  assert.equal(stripMention("@marketing draft a campaign"), "draft a campaign");
  assert.equal(stripMention("  @marketing  draft"), "draft");
  assert.equal(stripMention("no mention here"), "no mention here");
});
