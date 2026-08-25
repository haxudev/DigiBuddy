import assert from "node:assert/strict";
import test from "node:test";

import {
  COMMANDS_DOCUMENT,
  ConfigConflictError,
  ConfigValidationError,
  type ConfigStore,
  type DocumentName,
  type JsonDocument,
} from "./admin-config.ts";
import {
  commandPatch,
  commandRevision,
  readCommandsVersioned,
  removeCommandOverride,
  upsertCommandOverride,
  writeCommands,
} from "./admin-commands.ts";

class MemoryStore implements ConfigStore {
  document: JsonDocument | null = null;
  revision = "absent";

  async read(): Promise<JsonDocument | null> {
    return this.document;
  }

  async readVersioned(): Promise<{ document: JsonDocument | null; revision: string }> {
    return { document: this.document, revision: this.revision };
  }

  async write(
    name: DocumentName,
    document: JsonDocument,
    expectedRevision?: string,
  ): Promise<string> {
    assert.equal(name, COMMANDS_DOCUMENT);
    if (expectedRevision !== undefined && expectedRevision !== this.revision) {
      throw new ConfigConflictError(`${name} changed since it was read.`);
    }
    this.document = document;
    this.revision = `rev-${Number(this.revision.replace("rev-", "") || 0) + 1}`;
    return this.revision;
  }

  async writeBundle(): Promise<void> {}
  async deleteBundle(): Promise<void> {}
  async readArtifact(): Promise<Buffer | null> {
    return null;
  }
}

test("commands are written as a versioned document", async () => {
  const store = new MemoryStore();

  const commands = await writeCommands(store, [
    { name: "deck", title: "Deck", skills: ["pptx"] },
  ]);

  assert.deepEqual(commands, [{ name: "deck", title: "Deck", skills: ["pptx"] }]);
  assert.deepEqual(store.document, {
    commands: [{ name: "deck", title: "Deck", skills: ["pptx"] }],
    schema_version: 1,
  });
});

test("stored commands are normalised when read", async () => {
  const store = new MemoryStore();
  store.document = {
    commands: [
      { name: " Deck ", title: "Deck" },
      { name: "../escape", title: "Nope" },
    ],
  };
  store.revision = "rev-4";

  const result = await readCommandsVersioned(store);

  assert.deepEqual(result, {
    commands: [{ name: "deck", title: "Deck" }],
    revision: "rev-4",
  });
});

test("command patches keep absent fields absent", () => {
  const patch = commandPatch({ name: " Deck ", title: "", order: 2 });

  assert.deepEqual(patch, { name: "deck", title: "", order: 2 });
  assert.equal("description" in patch, false);
});

test("command patches reject invalid names", () => {
  assert.throws(
    () => commandPatch({ name: "../escape" }),
    ConfigValidationError,
  );
});

test("command revisions are optional for legacy clients", () => {
  assert.equal(commandRevision({ revision: "rev-1" }), "rev-1");
  assert.equal(commandRevision({}), undefined);
});

test("patching one command does not clobber the others", () => {
  const commands = upsertCommandOverride(
    [
      { name: "deck", title: "Deck", description: "old" },
      { name: "report", title: "Report" },
    ],
    { name: "deck", hint: "Bring notes" },
  );

  assert.deepEqual(commands, [
    { name: "deck", title: "Deck", description: "old", hint: "Bring notes" },
    { name: "report", title: "Report" },
  ]);
});

test("deleting an override leaves the rest of the document", () => {
  const result = removeCommandOverride(
    [
      { name: "deck", title: "Deck" },
      { name: "report", title: "Report" },
    ],
    "deck",
  );

  assert.deepEqual(result, {
    name: "deck",
    commands: [{ name: "report", title: "Report" }],
  });
});

test("deleting an unknown override reports the command name", () => {
  assert.throws(
    () => removeCommandOverride([{ name: "deck" }], "missing"),
    /No override is configured for command: missing/,
  );
});

test("conditional command writes report conflicts", async () => {
  const store = new MemoryStore();
  const { revision } = await readCommandsVersioned(store);
  await writeCommands(store, [{ name: "deck" }], revision);

  await assert.rejects(
    () => writeCommands(store, [{ name: "report" }], revision),
    ConfigConflictError,
  );
});

test("editing a command leaves it where it was in the document", () => {
  // A one-field edit should not rewrite the file in a new order.
  const commands = [
    { name: "first" },
    { name: "second", title: "Second" },
    { name: "third" },
  ];
  const next = upsertCommandOverride(commands, { name: "second", order: 3 });
  assert.deepEqual(
    next.map((command) => command.name),
    ["first", "second", "third"],
  );
});

test("a patch merges onto the stored override rather than replacing it", () => {
  const commands = [{ name: "assess", title: "Assessment", hint: "name the org" }];
  const [patched] = upsertCommandOverride(commands, { name: "assess", order: 1 });
  assert.equal(patched.title, "Assessment");
  assert.equal(patched.hint, "name the org");
  assert.equal(patched.order, 1);
});

test("a command that is not stored yet is appended", () => {
  const next = upsertCommandOverride([{ name: "first" }], { name: "second" });
  assert.deepEqual(
    next.map((command) => command.name),
    ["first", "second"],
  );
});
