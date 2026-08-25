import assert from "node:assert/strict";
import test from "node:test";

import { clampActive, isSuggestionKey, moveActive } from "./suggestions.ts";

test("the highlight moves down and wraps at the end", () => {
  assert.equal(moveActive(0, 3, "ArrowDown"), 1);
  assert.equal(moveActive(1, 3, "ArrowDown"), 2);
  assert.equal(moveActive(2, 3, "ArrowDown"), 0);
});

test("the highlight moves up and wraps at the start", () => {
  assert.equal(moveActive(2, 3, "ArrowUp"), 1);
  assert.equal(moveActive(1, 3, "ArrowUp"), 0);
  assert.equal(moveActive(0, 3, "ArrowUp"), 2);
});

test("Home and End jump to the ends of the list", () => {
  assert.equal(moveActive(2, 4, "Home"), 0);
  assert.equal(moveActive(1, 4, "End"), 3);
});

test("an empty list has nowhere to move", () => {
  assert.equal(moveActive(0, 0, "ArrowDown"), 0);
  assert.equal(moveActive(3, 0, "ArrowUp"), 0);
});

test("a highlight remembered from a longer list is brought back in range", () => {
  // The list is refiltered on every keystroke, so the remembered index
  // regularly points past the end of the list that is actually on screen.
  assert.equal(clampActive(7, 3), 2);
  assert.equal(clampActive(1, 3), 1);
  assert.equal(clampActive(-1, 3), 0);
  assert.equal(clampActive(0, 0), 0);
  assert.equal(moveActive(9, 3, "ArrowDown"), 0);
});

test("only the keys the menu owns are claimed from the composer", () => {
  assert.ok(isSuggestionKey("ArrowDown"));
  assert.ok(isSuggestionKey("End"));
  assert.equal(isSuggestionKey("Enter"), false);
  assert.equal(isSuggestionKey("a"), false);
});
