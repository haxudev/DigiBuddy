import assert from "node:assert/strict";
import test from "node:test";

import {
  dropSession,
  finishRun,
  forSession,
  isRunning,
  runState,
  setForSession,
  startRun,
  type RunStates,
} from "./session-runs.ts";

test("one conversation running says nothing about another", () => {
  // The whole point of keying by session: the console used to hold a single
  // `isRunning`, which is why switching sessions had to abort the run.
  const runs = startRun({}, "a", 1000);

  assert.equal(isRunning(runs, "a"), true);
  assert.equal(isRunning(runs, "b"), false);
  assert.equal(runState(runs, "a").startedAt, 1000);
  assert.equal(runState(runs, "b").startedAt, 0);
});

test("two conversations can be in flight at once", () => {
  const runs = startRun(startRun({}, "a", 1000), "b", 2000);

  assert.equal(isRunning(runs, "a"), true);
  assert.equal(isRunning(runs, "b"), true);

  const after = finishRun(runs, "a");
  assert.equal(isRunning(after, "a"), false);
  assert.equal(isRunning(after, "b"), true);
});

test("finishing a run forgets it rather than remembering an idle one", () => {
  // Otherwise long-lived state grows one entry per conversation ever opened.
  const runs: RunStates = startRun({}, "a", 1000);

  assert.deepEqual(finishRun(runs, "a"), {});
  // Finishing something that was never running is not a change at all.
  assert.equal(finishRun(runs, "b"), runs);
});

test("an idle conversation reads as the same empty list every time", () => {
  // Identity matters: these feed memo dependencies, and a fresh array per
  // render would rerender the transcript on every keystroke.
  const empty: string[] = [];

  assert.equal(forSession({}, "a", empty), empty);
  assert.equal(forSession({ b: ["x"] }, "a", empty), empty);
});

test("writing one conversation's list leaves the others alone", () => {
  const map = setForSession({ a: ["one"] }, "b", ["two"]);

  assert.deepEqual(map, { a: ["one"], b: ["two"] });
  assert.deepEqual(dropSession(map, "a"), { b: ["two"] });
  assert.equal(dropSession(map, "missing"), map);
});
