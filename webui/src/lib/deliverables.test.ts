import assert from "node:assert/strict";
import test from "node:test";
import {
  deliveryFocus,
  shouldOpenDeliverables,
} from "./deliverables.ts";

test("a new deliverable in the active session opens the window", () => {
  const before = deliveryFocus("s1", []);
  const after = deliveryFocus("s1", ["m1-managed-a-0"]);
  assert.equal(shouldOpenDeliverables(before, after), true);
});

test("a further deliverable in the same turn keeps opening the window", () => {
  const before = deliveryFocus("s1", ["m1-managed-a-0"]);
  const after = deliveryFocus("s1", ["m1-managed-a-0", "m1-managed-b-1"]);
  assert.equal(shouldOpenDeliverables(before, after), true);
});

test("an unchanged transcript never reopens the window", () => {
  const focus = deliveryFocus("s1", ["m1-managed-a-0"]);
  assert.equal(shouldOpenDeliverables(focus, focus), false);
});

test("switching sessions does not open old deliverables", () => {
  const before = deliveryFocus("s1", ["m1-managed-a-0"]);
  const after = deliveryFocus("s2", ["m9-managed-z-0"]);
  assert.equal(shouldOpenDeliverables(before, after), false);
});

test("a session without deliverables leaves the window closed", () => {
  const before = deliveryFocus("s1", ["m1-managed-a-0"]);
  const after = deliveryFocus("s1", []);
  assert.equal(shouldOpenDeliverables(before, after), false);
});
