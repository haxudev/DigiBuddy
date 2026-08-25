import assert from "node:assert/strict";
import test from "node:test";

import {
  ConfigConflictError,
  ConfigValidationError,
  SKILL_POLICY_DOCUMENT,
  type ConfigStore,
  type DocumentName,
  type JsonDocument,
} from "./admin-config.ts";
import {
  readSkillPolicyVersioned,
  skillPolicyPatch,
  skillPolicyRevision,
  toggleSkillPolicy,
  writeSkillPolicy,
} from "./admin-skill-policy.ts";

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
    assert.equal(name, SKILL_POLICY_DOCUMENT);
    if (expectedRevision !== undefined && expectedRevision !== this.revision) {
      throw new ConfigConflictError(`${name} changed since it was read.`);
    }
    this.document = document;
    this.revision = `rev-${Number(this.revision.replace("rev-", "") || 0) + 1}`;
    return this.revision;
  }

  async writeBundle(): Promise<void> {}
  async readBundle(): Promise<Buffer | null> {
    return null;
  }
  async deleteBundle(): Promise<void> {}
  async readArtifact(): Promise<Buffer | null> {
    return null;
  }
  async writeArtifact(): Promise<void> {}
}

test("skill policy is written as a versioned document", async () => {
  const store = new MemoryStore();

  const disabled = await writeSkillPolicy(store, ["research", "../escape", "research"]);

  assert.deepEqual(disabled, ["research"]);
  assert.deepEqual(store.document, {
    disabled: ["research"],
    schema_version: 1,
  });
});

test("stored skill policy is normalised when read", async () => {
  const store = new MemoryStore();
  store.document = { disabled: [" Pptx ", "../escape"] };
  store.revision = "rev-4";

  const result = await readSkillPolicyVersioned(store);

  assert.deepEqual(result, { disabled: ["pptx"], revision: "rev-4" });
});

test("skill policy patches validate one toggle", () => {
  assert.deepEqual(skillPolicyPatch({ name: " Research ", enabled: false }), {
    name: "research",
    enabled: false,
  });
  assert.throws(
    () => skillPolicyPatch({ name: "../escape", enabled: false }),
    ConfigValidationError,
  );
  assert.throws(
    () => skillPolicyPatch({ name: "research", enabled: "nope" }),
    ConfigValidationError,
  );
});

test("skill policy revisions are optional for legacy clients", () => {
  assert.equal(skillPolicyRevision({ revision: "rev-1" }), "rev-1");
  assert.equal(skillPolicyRevision({}), undefined);
});

test("toggling one skill does not clobber the others", () => {
  const disabled = toggleSkillPolicy(["research", "pptx"], {
    name: "research",
    enabled: true,
  });

  assert.deepEqual(disabled, ["pptx"]);
  assert.deepEqual(
    toggleSkillPolicy(disabled, { name: "review", enabled: false }),
    ["pptx", "review"],
  );
});

test("conditional skill policy writes report conflicts", async () => {
  const store = new MemoryStore();
  const { revision } = await readSkillPolicyVersioned(store);
  await writeSkillPolicy(store, ["research"], revision);

  await assert.rejects(
    () => writeSkillPolicy(store, ["pptx"], revision),
    ConfigConflictError,
  );
});
