import assert from "node:assert/strict";
import test from "node:test";

import {
  activityFromUpstream,
  liveSummary,
  reduceActivity,
  settleActivity,
  summarize,
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

test("a thought still being written shows its newest line", () => {
  // `summarize` reads from the start, which would freeze the row on the first
  // sentence for the whole of a long reasoning block.
  const detail = "**Reading the repository**\nNow checking the test suite";

  assert.equal(liveSummary(detail), "Now checking the test suite");
  assert.equal(summarize(detail), "Reading the repository Now checking the test suite");
});

test("a live line keeps its end rather than its beginning", () => {
  const tail = "the part that matters";
  const line = `${"x".repeat(400)} ${tail}`;

  const live = liveSummary(line);
  assert.ok(live.startsWith("…"));
  assert.ok(live.endsWith(tail));
  assert.ok(live.length <= 121);
});

test("a thought with nothing in it yet still says something", () => {
  assert.equal(liveSummary(""), "Thinking…");
  assert.equal(liveSummary("\n \n"), "Thinking…");
  assert.equal(liveSummary("", "Working…"), "Working…");
});

test("the collapsed line drops markdown the trail cannot render", () => {
  // Reasoning summaries are written as markdown and the row is one plain line,
  // so the emphasis markers would otherwise be shown literally.
  assert.equal(summarize("**Reading the request**"), "Reading the request");
  assert.equal(summarize("## Planning\nSix slides"), "Planning Six slides");
  assert.equal(summarize("Ran `npm test` twice"), "Ran npm test twice");
  assert.equal(liveSummary("**Planning the deck**"), "Planning the deck");
});

test("what is not markdown emphasis is left alone", () => {
  assert.equal(summarize("2 * 3 * 4"), "2 * 3 * 4");
  assert.equal(summarize("snake_case_name stays"), "snake_case_name stays");
  assert.equal(summarize("a*b"), "a*b");
});
