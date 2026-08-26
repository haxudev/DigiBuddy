import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ConfigConflictError,
  ConfigStoreUnavailableError,
  ConfigValidationError,
  SCHEMA_VERSION,
  artifactStoragePath,
  assertReadableSchema,
  assertWritableDocument,
  buildConfigStore,
  normaliseCatalogue,
  normaliseMcp,
  normaliseModels,
  normaliseProfiles,
  normaliseSkillPolicy,
  normaliseSkills,
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

test("model and profile overlays accept the runtime reasoning efforts", () => {
  assert.equal(normaliseModels({ reasoning_effort: "XHIGH" }).reasoning_effort, "xhigh");
  assert.equal(normaliseModels({ reasoning_effort: "max" }).reasoning_effort, "max");

  const { profiles } = normaliseProfiles({
    profiles: [
      { name: "deep", reasoning_effort: "xhigh" },
      { name: "maximum", reasoning_effort: "MAX" },
    ],
  });
  assert.deepEqual(
    profiles.map((profile) => profile.reasoning_effort),
    ["xhigh", "max"],
  );
});

test("the retired minimal reasoning effort is no longer accepted", () => {
  assert.equal(normaliseModels({ reasoning_effort: "minimal" }).reasoning_effort, "");
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

test("malformed profile selections fail instead of granting everything", () => {
  for (const field of ["skills", "tools", "mcp_servers"] as const) {
    assert.throws(
      () =>
        normaliseProfiles({
          profiles: [{ name: "broken", [field]: "pptx" }],
        }),
      ConfigValidationError,
    );
  }
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
  assert.equal(assertWritableDocument("skill-policy.json"), "skill-policy.json");
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

test("an absent document reads as absent, an unreachable store does not", async () => {
  // The two used to be indistinguishable, which is how an unreachable storage
  // account came to look like a deployment that simply had no skills.
  const directory = mkdtempSync(join(tmpdir(), "digibuddy-unreachable-"));
  try {
    assert.equal(
      await buildConfigStore({ DIGIBUDDY_CONFIG_DIR: directory }).read(
        "catalogue.json",
      ),
      null,
    );

    // A path that is a file, not a directory, fails with ENOTDIR rather than
    // ENOENT: the store cannot be read at all.
    const blocked = join(directory, "not-a-directory");
    writeFileSync(blocked, "", "utf-8");
    await assert.rejects(
      () =>
        buildConfigStore({ DIGIBUDDY_CONFIG_DIR: blocked }).read("catalogue.json"),
      ConfigStoreUnavailableError,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a store failure never repeats anything that could carry a credential", async () => {
  const directory = mkdtempSync(join(tmpdir(), "digibuddy-unreachable-"));
  try {
    const blocked = join(directory, "not-a-directory");
    writeFileSync(blocked, "", "utf-8");
    await assert.rejects(
      () =>
        buildConfigStore({ DIGIBUDDY_CONFIG_DIR: blocked }).read("catalogue.json"),
      (error: Error) => {
        assert.match(error.message, /catalogue\.json/);
        assert.match(error.message, /ENOTDIR/);
        return true;
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("every normalised document declares the schema it was written to", () => {
  assert.equal(normaliseModels({ model: "a" }).schema_version, SCHEMA_VERSION);
  assert.equal(normaliseMcp({ servers: {} }).schema_version, SCHEMA_VERSION);
  assert.equal(
    normaliseProfiles({ profiles: [{ name: "a" }] }).schema_version,
    SCHEMA_VERSION,
  );
  assert.equal(normaliseSkills({ skills: [] }).schema_version, SCHEMA_VERSION);
});

test("a document written to a newer schema is refused rather than reinterpreted", () => {
  assert.throws(
    () => assertReadableSchema({ schema_version: SCHEMA_VERSION + 1 }),
    ConfigValidationError,
  );
  assert.throws(
    () => assertReadableSchema({ schema_version: "one" }),
    ConfigValidationError,
  );
  // The legacy unversioned shape still reads, so an existing deployment keeps
  // working across the upgrade.
  assert.doesNotThrow(() => assertReadableSchema({ profiles: [] }));
});

test("a conditional write refuses to overwrite a document that moved", async () => {
  const directory = mkdtempSync(join(tmpdir(), "digibuddy-cas-"));
  try {
    const store = buildConfigStore({ DIGIBUDDY_CONFIG_DIR: directory });
    const first = await store.write("profiles.json", { profiles: [{ name: "a" }] });

    // A second administrator saved between this reader's load and its save.
    await store.write("profiles.json", { profiles: [{ name: "b" }] }, first);

    await assert.rejects(
      () => store.write("profiles.json", { profiles: [{ name: "c" }] }, first),
      ConfigConflictError,
    );
    const current = await store.readVersioned("profiles.json");
    assert.deepEqual(
      (current.document as { profiles: { name: string }[] }).profiles,
      [{ name: "b" }],
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a first write only succeeds when no document is expected", async () => {
  const directory = mkdtempSync(join(tmpdir(), "digibuddy-cas-new-"));
  try {
    const store = buildConfigStore({ DIGIBUDDY_CONFIG_DIR: directory });
    const empty = await store.readVersioned("profiles.json");
    assert.equal(empty.document, null);

    await store.write("profiles.json", { profiles: [] }, empty.revision);
    await assert.rejects(
      () => store.write("profiles.json", { profiles: [] }, empty.revision),
      ConfigConflictError,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("artifact paths are partitioned by owner", () => {
  const id = "a".repeat(32);
  const owner = "b".repeat(32);

  assert.equal(
    artifactStoragePath(id, "report.pdf", owner),
    `artifacts/${owner}/${id}/report.pdf`,
  );
  // Pre-multi-user files stay reachable at the flat path.
  assert.equal(artifactStoragePath(id, "report.pdf"), `artifacts/${id}/report.pdf`);
});

test("an owner that is not an owner key is refused", () => {
  const id = "a".repeat(32);

  for (const bad of ["../../etc", "short", "B".repeat(32), `${"b".repeat(31)}/x`]) {
    assert.throws(
      () => artifactStoragePath(id, "report.pdf", bad),
      ConfigValidationError,
      `owner ${bad} should be refused`,
    );
  }
});

test("a tool name with an underscore is storable", () => {
  // Tools are Python identifiers, so `release_notes` is a normal name. The
  // bundle path validator only accepted hyphens, which made every tool pack
  // silently unstorable and surfaced as "No module named ..." at use.
  const digest = "a".repeat(64);
  const document = normaliseSkills({
    skills: [
      { name: "release_notes", kind: "tool", sha256: digest, approved_sha256: digest },
    ],
  });

  assert.equal(document.skills[0].bundle, `bundles/release_notes/${digest}.zip`);
});

test("a capability name is still one safe path segment", () => {
  const digest = "a".repeat(64);
  for (const bad of ["../escape", "has space", "UPPER", "trailing-", "_leading"]) {
    assert.throws(
      () => normaliseSkills({ skills: [{ name: bad, sha256: digest }] }),
      ConfigValidationError,
      `${bad} should be refused`,
    );
  }
});

// --- Catalogue skill entries -----------------------------------------------

test("skill entries carry the description the runtime published", () => {
  const catalogue = normaliseCatalogue({
    skills: ["pptx"],
    skill_entries: [
      {
        name: "pptx",
        description: "Make decks.",
        source: "packaged",
        availability: "builtin",
      },
    ],
  });
  assert.deepEqual(catalogue.skill_entries, [
    {
      name: "pptx",
      description: "Make decks.",
      source: "packaged",
      enabled: true,
      availability: "builtin",
    },
  ]);
});

test("a runtime too old to publish entries states no origin at all", () => {
  // The console uses `source` to decide whether an upload is being shadowed by
  // a skill in the image. Defaulting the answer to "packaged" would accuse
  // every deployed skill of colliding during the window where the runtime and
  // the console are on different rollouts.
  const catalogue = normaliseCatalogue({ skills: ["uploaded", "other"] });
  assert.deepEqual(
    catalogue.skill_entries.map((entry) => [entry.source, entry.enabled]),
    [["", true], ["", true]],
  );
});

test("published entries are the inventory rather than decorations", () => {
  const catalogue = normaliseCatalogue({
    skills: ["described", "bare"],
    skill_entries: [{ name: "described", description: "Known.", source: "deployed" }],
  });
  assert.deepEqual(catalogue.skill_entries, [
    {
      name: "described",
      description: "Known.",
      source: "deployed",
      enabled: true,
      availability: "",
    },
  ]);
});

test("an unrecognised availability is read as the runtime saying nothing", () => {
  // The field decides whether a skill reaches the chat menu. A value the
  // console does not understand must not be carried through as if it did: the
  // safe reading is silence, which behaves like every skill did before the
  // field existed.
  const catalogue = normaliseCatalogue({
    skills: ["odd"],
    skill_entries: [{ name: "odd", description: "", availability: "invisible" }],
  });
  assert.equal(catalogue.skill_entries[0].availability, "");
});

test("an unrecognised source is not taken at its word", () => {
  const catalogue = normaliseCatalogue({
    skills: ["odd"],
    skill_entries: [{ name: "odd", description: "", source: "smuggled" }],
  });
  assert.equal(catalogue.skill_entries[0].source, "");
});

test("disabled skills remain in the inventory", () => {
  const catalogue = normaliseCatalogue({
    skills: ["real"],
    skill_entries: [
      { name: "real", description: "", source: "packaged", enabled: true },
      { name: "paused", description: "Not active.", source: "packaged", enabled: false },
      { name: "older-disabled", description: "Not active.", source: "packaged" },
    ],
  });
  assert.deepEqual(
    catalogue.skill_entries.map((entry) => [entry.name, entry.enabled]),
    [["real", true], ["paused", false], ["older-disabled", false]],
  );
});

test("malformed catalogue entries cannot invent skills", () => {
  // `skill_entries` is now the inventory, so absence from `skills` means a
  // skill may be disabled rather than fake. The boundary that still matters is
  // the runtime name convention: path-shaped or empty entries are not skills.
  const catalogue = normaliseCatalogue({
    skills: ["real"],
    skill_entries: [
      { name: "real", description: "", source: "packaged", enabled: true },
      { name: "../escape", description: "Not published.", source: "packaged" },
      { name: "", description: "Nameless.", source: "packaged" },
    ],
  });
  assert.deepEqual(
    catalogue.skill_entries.map((entry) => entry.name),
    ["real"],
  );
});

// --- Packaged skill policy -------------------------------------------------

test("skill policy keeps only usable skill names", () => {
  const policy = normaliseSkillPolicy({
    disabled: [" Research ", "../escape", "research", "pptx", 42],
  });

  assert.deepEqual(policy, {
    disabled: ["research", "pptx"],
    schema_version: SCHEMA_VERSION,
  });
});

test("skill policy tolerates a missing or malformed document", () => {
  assert.deepEqual(normaliseSkillPolicy(null), {
    disabled: [],
    schema_version: SCHEMA_VERSION,
  });
  assert.deepEqual(normaliseSkillPolicy({ disabled: "nope" }), {
    disabled: [],
    schema_version: SCHEMA_VERSION,
  });
});
