import assert from "node:assert/strict";
import test from "node:test";

import {
  activityFromUpstream,
  reduceActivity,
  settleActivity,
  type ActivityEntry,
} from "./activity.ts";

test("reasoning deltas become thinking events", () => {
  assert.deepEqual(
    activityFromUpstream({
      type: "response.reasoning_summary_text.delta",
      item_id: "r1",
      delta: "weighing options",
    }),
    { kind: "thinking", id: "r1", delta: "weighing options" },
  );
});

test("unrelated stream events are ignored", () => {
  assert.equal(
    activityFromUpstream({ type: "response.output_text.delta", delta: "hi" }),
    null,
  );
});

test("only function call output items become tool events", () => {
  assert.equal(
    activityFromUpstream({
      type: "response.output_item.added",
      item: { type: "message", id: "m1" },
    }),
    null,
  );
  assert.deepEqual(
    activityFromUpstream({
      type: "response.output_item.added",
      item: { type: "function_call", id: "c1", name: "commandExecution" },
    }),
    { kind: "tool", id: "c1", name: "commandExecution" },
  );
});

test("thinking rows accumulate detail and collapse to one line", () => {
  let entries: ActivityEntry[] = [];
  entries = reduceActivity(entries, { kind: "thinking", id: "r1", delta: "first\n" });
  entries = reduceActivity(entries, { kind: "thinking", id: "r1", delta: "second" });

  assert.equal(entries.length, 1);
  assert.equal(entries[0].detail, "first\nsecond");
  assert.equal(entries[0].title, "first second");
  assert.equal(entries[0].status, "running");
});

test("tool arguments upgrade the title to the streamed summary", () => {
  let entries = reduceActivity([], {
    kind: "tool",
    id: "c1",
    name: "commandExecution",
  });
  assert.equal(entries[0].title, "Ran a command");

  entries = reduceActivity(entries, {
    kind: "tool-detail",
    id: "c1",
    delta: '{"summary":"pytest',
  });
  // Incomplete JSON must keep the label rather than showing a fragment.
  assert.equal(entries[0].title, "Ran a command");

  entries = reduceActivity(entries, { kind: "tool-detail", id: "c1", delta: ' -q"}' });
  assert.equal(entries[0].title, "pytest -q");

  entries = reduceActivity(entries, { kind: "tool-end", id: "c1" });
  assert.equal(entries[0].status, "done");
});

test("details for an unknown tool are dropped", () => {
  assert.deepEqual(
    reduceActivity([], { kind: "tool-detail", id: "missing", delta: "x" }),
    [],
  );
});

test("an error fails everything still running", () => {
  const running = reduceActivity([], { kind: "thinking", id: "r1", delta: "x" });
  const entries = reduceActivity(running, {
    kind: "error",
    id: "e1",
    message: "upstream refused the request",
  });

  assert.equal(entries[0].status, "failed");
  assert.equal(entries[1].kind, "error");
  assert.equal(entries[1].title, "upstream refused the request");
});

test("settling closes rows the run left open", () => {
  const running = reduceActivity([], { kind: "thinking", id: "r1", delta: "x" });

  assert.equal(settleActivity(running)[0].status, "done");
  const settled = settleActivity(running);
  assert.equal(settleActivity(settled), settled);
});
