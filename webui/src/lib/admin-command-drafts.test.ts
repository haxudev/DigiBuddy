import assert from "node:assert/strict";
import test from "node:test";

import {
  commandDraftKey,
  createLocalCommandDraft,
  mergeCommandDraftsAfterRefresh,
  parseCommandOrder,
} from "./admin-command-drafts.ts";

test("local command draft keys do not depend on editable fields", () => {
  const draft = createLocalCommandDraft("draft-1");
  const key = commandDraftKey(draft);

  draft.name = "customer-brief";

  assert.equal(commandDraftKey(draft), key);
});

test("discovered command draft keys survive the first edit", () => {
  const key = commandDraftKey({ name: "pdf" }, { name: "pdf" });

  assert.equal(commandDraftKey({ name: "pdf", title: "PDF" }), key);
});

test("refresh keeps local and dirty drafts while accepting clean server rows", () => {
  const drafts = [
    { name: "stored", title: "Edited title" },
    { name: "clean", title: "Clean title" },
    createLocalCommandDraft("local-1"),
    { name: "pdf", hint: "Unsaved discovered edit" },
  ];
  const refreshed = [
    { name: "stored", title: "Server title", hint: "New server hint" },
    { name: "clean", title: "Server clean title" },
    { name: "new-server", title: "New server row" },
  ];

  const merged = mergeCommandDraftsAfterRefresh(
    drafts,
    refreshed,
    new Set(["stored", "pdf"]),
  );

  assert.deepEqual(merged, [
    { name: "stored", title: "Edited title", hint: "New server hint" },
    { name: "clean", title: "Server clean title" },
    { name: "new-server", title: "New server row" },
    createLocalCommandDraft("local-1"),
    { name: "pdf", hint: "Unsaved discovered edit" },
  ]);
});

test("refresh can drop a draft that was just saved or deleted", () => {
  const local = createLocalCommandDraft("local-1");
  local.name = "brief";

  const merged = mergeCommandDraftsAfterRefresh(
    [local],
    [{ name: "brief", title: "Brief" }],
    new Set(),
    new Set(["brief"]),
  );

  assert.deepEqual(merged, [{ name: "brief", title: "Brief" }]);
});

test("command order parsing keeps transient input without producing NaN", () => {
  assert.deepEqual(parseCommandOrder("-", 3), { order: 3, orderInput: "-" });
  assert.deepEqual(parseCommandOrder("-10", 3), {
    order: -10,
    orderInput: "-10",
  });
});
