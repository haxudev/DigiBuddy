import assert from "node:assert/strict";
import test from "node:test";

import { formatAskUserAnswer, parseAskUser, splitMessage } from "./ask-user.ts";

test("a choice question is parsed into options", () => {
  const request = parseAskUser(
    JSON.stringify({
      question: "Which runtime?",
      type: "single",
      options: ["Foundry", { value: "aca", label: "Container Apps", description: "Legacy" }],
      allowOther: true,
    }),
    "fallback",
  );
  assert.ok(request);
  assert.equal(request.type, "single");
  assert.equal(request.allowOther, true);
  assert.deepEqual(request.options, [
    { value: "Foundry", label: "Foundry", description: "" },
    { value: "aca", label: "Container Apps", description: "Legacy" },
  ]);
});

test("a question without usable options becomes a text prompt", () => {
  const request = parseAskUser(
    JSON.stringify({ question: "Name the branch", type: "single", options: [] }),
    "fallback",
  );
  assert.equal(request?.type, "text");
  assert.equal(request?.id, "fallback");
});

test("unparseable blocks are rejected instead of half-rendered", () => {
  assert.equal(parseAskUser("{not json", "id"), null);
  assert.equal(parseAskUser("{}", "id"), null);
  assert.equal(parseAskUser('{"question":"  "}', "id"), null);
});

test("ask blocks are lifted out of the surrounding markdown", () => {
  const text = [
    "Here is the plan.",
    "```ask-user",
    '{"question":"Pick one","options":["a","b"]}',
    "```",
    "Tell me when ready.",
  ].join("\n");

  const segments = splitMessage(text, "m1");
  assert.equal(segments.length, 3);
  const [intro, ask, outro] = segments;
  assert.equal(ask.kind, "ask");
  assert.ok(intro.kind === "markdown" && !intro.text.includes("ask-user"));
  assert.ok(outro.kind === "markdown" && outro.text.includes("Tell me when ready."));
});

test("a malformed ask block stays visible as markdown", () => {
  const text = "```ask-user\nnot json\n```";
  const segments = splitMessage(text, "m1");
  assert.deepEqual(segments, [{ kind: "markdown", text }]);
});

test("plain text yields a single markdown segment", () => {
  assert.deepEqual(splitMessage("hello", "m1"), [
    { kind: "markdown", text: "hello" },
  ]);
});

test("answers are formatted for the agent", () => {
  const choice = parseAskUser(
    JSON.stringify({ question: "Pick", options: ["a", "b"], type: "multi" }),
    "id",
  );
  assert.ok(choice);
  assert.equal(formatAskUserAnswer(choice, ["a", " b "]), "Pick\n- a\n- b");
  assert.equal(formatAskUserAnswer(choice, ["  "]), "");

  const free = parseAskUser(JSON.stringify({ question: "Why?", type: "text" }), "id");
  assert.ok(free);
  assert.equal(formatAskUserAnswer(free, ["because"]), "because");
});
