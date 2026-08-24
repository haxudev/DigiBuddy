import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ConfigValidationError,
  artifactStoragePath,
  assertWritableDocument,
  buildConfigStore,
  normaliseMcp,
  normaliseModels,
  normaliseProfiles,
  preserveSecret,
  redactDocument,
} from "./admin-config.ts";

test("model overlay drops plaintext endpoints", () => {
  assert.throws(
    () => normaliseModels({ endpoint: "http://example.com/v1" }),
    ConfigValidationError,
  );
});

test("model overlay trims trailing slashes and unknown efforts", () => {
  const document = normaliseModels({
    model: " gpt-5.2 ",
    endpoint: "https://example.openai.azure.com/openai/v1/",
    reasoning_effort: "TURBO",
  });

  assert.equal(document.model, "gpt-5.2");
  assert.equal(document.endpoint, "https://example.openai.azure.com/openai/v1");
  assert.equal(document.reasoning_effort, "");
});

test("the api key is never read back out", () => {
  const redacted = redactDocument("models.json", {
    model: "gpt-5.2",
    api_key: "super-secret",
  });

  assert.equal(JSON.stringify(redacted).includes("super-secret"), false);
  assert.equal((redacted as Record<string, unknown>).api_key_set, true);
});

test("a blank key keeps the stored one", () => {
  const next = preserveSecret(normaliseModels({ model: "gpt-5.2" }), {
    api_key: "stored",
  });

  assert.equal(next.api_key, "stored");
});

test("mcp servers must be named safely and use https", () => {
  assert.throws(
    () => normaliseMcp({ servers: { "bad name": { url: "https://a.example" } } }),
    ConfigValidationError,
  );
  assert.throws(
    () => normaliseMcp({ servers: { learn: { url: "http://a.example" } } }),
    ConfigValidationError,
  );
  assert.throws(
    () => normaliseMcp({ servers: { learn: {} } }),
    ConfigValidationError,
  );
});

test("mcp servers default to enabled", () => {
  const { servers } = normaliseMcp({
    servers: {
      learn: { url: "https://a.example" },
      pricing: { url: "https://b.example", enabled: false },
    },
  });

  assert.equal(servers.learn.enabled, true);
  assert.equal(servers.pricing.enabled, false);
});

test("absent profile selections keep every capability", () => {
  const { profiles } = normaliseProfiles({ profiles: [{ name: "full" }] });

  assert.equal(profiles[0].skills, null);
  assert.equal(profiles[0].display_name, "full");
});

test("an empty profile selection restricts to nothing", () => {
  const { profiles } = normaliseProfiles({
    profiles: [{ name: "locked", skills: [] }],
  });

  assert.deepEqual(profiles[0].skills, []);
});

test("profile names are validated and must be unique", () => {
  assert.throws(
    () => normaliseProfiles({ profiles: [{ name: "Not Valid" }] }),
    ConfigValidationError,
  );
  assert.throws(
    () => normaliseProfiles({ profiles: [{ name: "a" }, { name: "a" }] }),
    ConfigValidationError,
  );
  assert.throws(() => normaliseProfiles({ profiles: [{}] }), ConfigValidationError);
});

test("the catalogue is published by the runtime, not the console", () => {
  assert.throws(
    () => assertWritableDocument("catalogue.json"),
    ConfigValidationError,
  );
  assert.throws(() => assertWritableDocument("../secrets"), ConfigValidationError);
  assert.equal(assertWritableDocument("mcp.json"), "mcp.json");
});

test("the file store round-trips a document", async () => {
  const directory = mkdtempSync(join(tmpdir(), "digibuddy-config-"));
  const store = buildConfigStore({ DIGIBUDDY_CONFIG_DIR: directory });

  assert.equal(await store.read("models.json"), null);
  await store.write("models.json", { model: "gpt-5.2" });
  assert.deepEqual(await store.read("models.json"), { model: "gpt-5.2" });
});

test("artifact storage paths cannot escape their reserved prefix", () => {
  const id = "a".repeat(32);
  assert.equal(artifactStoragePath(id, "报告.md"), `artifacts/${id}/报告.md`);
  assert.throws(() => artifactStoragePath("short", "report.md"), ConfigValidationError);
  assert.throws(
    () => artifactStoragePath(id, "../models.json"),
    ConfigValidationError,
  );
});

test("the file store reads managed artifacts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "digibuddy-artifact-"));
  try {
    const id = "b".repeat(32);
    const artifactDirectory = join(directory, "artifacts", id);
    mkdirSync(artifactDirectory, { recursive: true });
    writeFileSync(join(artifactDirectory, "report.md"), "# Report", "utf-8");
    const store = buildConfigStore({ DIGIBUDDY_CONFIG_DIR: directory });

    assert.equal(
      (await store.readArtifact(id, "report.md"))?.toString("utf-8"),
      "# Report",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an unconfigured store is refused rather than silently empty", () => {
  assert.throws(() => buildConfigStore({}), ConfigValidationError);
  assert.throws(
    () => buildConfigStore({ DIGIBUDDY_CONFIG_URI: "http://example.com/c" }),
    ConfigValidationError,
  );
});
