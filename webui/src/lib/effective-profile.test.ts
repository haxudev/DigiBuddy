import assert from "node:assert/strict";
import test from "node:test";

import {
  extractEffectiveProfile,
  stripProfileMetadata,
} from "./effective-profile.ts";

function marker(profile: Record<string, unknown>): string {
  return `<!-- digibuddy-profile:${JSON.stringify({ version: 1, profile })} -->`;
}

test("the effective profile is read from the assistant message", () => {
  const effective = extractEffectiveProfile(
    `Done.\n${marker({
      profile: "marketing",
      display_name: "Marketing Partner",
      requested: "marketing",
      status: "bound",
    })}`,
  );

  assert.equal(effective?.profile, "marketing");
  assert.equal(effective?.display_name, "Marketing Partner");
  assert.equal(effective?.status, "bound");
});

test("a contradicted turn reports both what ran and what was asked for", () => {
  const effective = extractEffectiveProfile(
    marker({
      profile: "marketing",
      display_name: "Marketing",
      requested: "support-desk",
      status: "contradicted",
    }),
  );

  assert.equal(effective?.profile, "marketing");
  assert.equal(effective?.requested, "support-desk");
  assert.equal(effective?.status, "contradicted");
});

test("the newest marker wins, because it describes the binding in force", () => {
  const effective = extractEffectiveProfile(
    `${marker({ profile: "a", status: "bound" })}\nlater\n${marker({
      profile: "b",
      status: "bound",
    })}`,
  );

  assert.equal(effective?.profile, "b");
});

test("a message with no marker, or an unreadable one, reports nothing", () => {
  assert.equal(extractEffectiveProfile("just prose"), null);
  assert.equal(
    extractEffectiveProfile("<!-- digibuddy-profile:{not json} -->"),
    null,
  );
  // A marker without a profile name cannot identify an agent, so it is not one.
  assert.equal(extractEffectiveProfile(marker({ display_name: "X" })), null);
});

test("the marker never reaches the reader", () => {
  const message = `Here you go.${marker({ profile: "a", status: "bound" })}`;

  assert.equal(stripProfileMetadata(message).trim(), "Here you go.");
});
