import assert from "node:assert/strict";
import test from "node:test";

import { ConfigConflictError, ConfigValidationError } from "./admin-config.ts";
import { SkillBundleError, explodeBundle } from "./skill-bundle.ts";
import { readDirectory, readEntry } from "./zip.ts";
import { deployBundle, fetchArchive, previewBundle } from "./skill-import.ts";
import { zip } from "./zip-fixture.test-helper.ts";

/** Read an exploded bundle back into a `path -> { body, mode }` map. */
function unpack(payload: Buffer): Map<string, { body: string; mode: number }> {
  const files = new Map<string, { body: string; mode: number }>();
  for (const entry of readDirectory(payload, 2000)) {
    files.set(entry.name, {
      body: readEntry(payload, entry).toString("utf-8"),
      mode: entry.mode & 0o777,
    });
  }
  return files;
}

const MATURITY = {
  "agent-maturity-main/digibuddy-skills.json": JSON.stringify({
    skills: [
      { name: "agent-maturity-assess", path: "skills/agent-maturity-assess" },
      { name: "agent-maturity-report", path: "skills/agent-maturity-report" },
    ],
    shared: [
      {
        path: "src/agent_maturity",
        as: "_lib/agent_maturity",
        skills: ["agent-maturity-*"],
      },
    ],
    entrypoints: [
      {
        path: "scripts/amx.py",
        module: "agent_maturity.cli",
        call: "main",
        skills: ["agent-maturity-*"],
      },
    ],
  }),
  "agent-maturity-main/skills/agent-maturity-assess/SKILL.md":
    "---\nname: agent-maturity-assess\ndescription: Score an agent against the maturity pillars.\n---\n\nBody.",
  "agent-maturity-main/skills/agent-maturity-assess/references/pillars.md": "# pillars",
  "agent-maturity-main/skills/agent-maturity-report/SKILL.md":
    "---\nname: agent-maturity-report\ndescription: Render the report.\n---\n",
  "agent-maturity-main/src/agent_maturity/__init__.py": "",
  "agent-maturity-main/src/agent_maturity/cli.py": "def main():\n    return 0\n",
  "agent-maturity-main/README.md": "# agent maturity",
};

test("a manifest archive becomes one self-contained bundle per skill", () => {
  const exploded = explodeBundle(zip(MATURITY), "agent-maturity-main.zip");
  assert.equal(exploded.layout, "manifest");
  assert.deepEqual(
    exploded.skills.map((skill) => skill.name),
    ["agent-maturity-assess", "agent-maturity-report"],
  );

  const assess = unpack(exploded.skills[0].payload);
  // Its own files, the shared package and a generated entrypoint, all rooted at
  // the skill so the runtime sees an ordinary single-skill bundle.
  assert.ok(assess.has("agent-maturity-assess/SKILL.md"));
  assert.ok(assess.has("agent-maturity-assess/references/pillars.md"));
  assert.ok(assess.has("agent-maturity-assess/_lib/agent_maturity/cli.py"));
  assert.match(
    assess.get("agent-maturity-assess/scripts/amx.py")!.body,
    /sys\.path\.insert\(0, str\(Path\(__file__\)\.resolve\(\)\.parent \/ "_lib"\)\)/,
  );
  assert.match(
    assess.get("agent-maturity-assess/scripts/amx.py")!.body,
    /from agent_maturity\.cli import main/,
  );
  // Nothing from outside the declared paths leaks in.
  assert.ok(!assess.has("agent-maturity-assess/README.md"));
});

test("the description comes from the SKILL.md frontmatter", () => {
  const exploded = explodeBundle(zip(MATURITY), "agent-maturity-main.zip");
  assert.equal(
    exploded.skills[0].description,
    "Score an agent against the maturity pillars.",
  );
});

test("a frontmatter name that contradicts its directory is refused", () => {
  assert.throws(
    () =>
      explodeBundle(
        zip({
          "repo-main/skills/alpha/SKILL.md": "---\nname: beta\n---\n",
        }),
        "repo.zip",
      ),
    SkillBundleError,
  );
});

test("a repository archive without a manifest discovers its skills", () => {
  const exploded = explodeBundle(
    zip({
      "superclarity-main/README.md": "# superclarity",
      "superclarity-main/skills/clarifying-intent/SKILL.md": "# clarify",
      "superclarity-main/skills/drafting-plans/SKILL.md": "# draft",
      // Fixtures nested inside a skill are not skills of their own.
      "superclarity-main/skills/drafting-plans/examples/demo/SKILL.md": "# example",
    }),
    "superclarity-main.zip",
  );
  assert.equal(exploded.layout, "discovered");
  assert.deepEqual(
    exploded.skills.map((skill) => skill.name),
    ["clarifying-intent", "drafting-plans"],
  );
});

test("an executable script keeps its execute bit through the explosion", () => {
  const exploded = explodeBundle(
    zip(
      {
        "repo-main/skills/demo/SKILL.md": "# demo",
        "repo-main/skills/demo/scripts/run.sh": "#!/bin/sh\n",
        "repo-main/skills/demo/references/notes.md": "notes",
      },
      { executable: ["repo-main/skills/demo/scripts/run.sh"] },
    ),
    "repo.zip",
  );
  const files = unpack(exploded.skills[0].payload);
  assert.equal(files.get("demo/scripts/run.sh")!.mode, 0o755);
  // Everything else is normalised, so a crafted archive cannot publish a
  // setuid or world-writable file.
  assert.equal(files.get("demo/references/notes.md")!.mode, 0o644);
});

test("a plain single-skill zip passes through with its bytes untouched", () => {
  const payload = zip({ "seo-optimizer/SKILL.md": "---\ndescription: Rank.\n---\n" });
  const exploded = explodeBundle(payload, "upload.zip");
  assert.equal(exploded.layout, "single");
  assert.equal(exploded.skills.length, 1);
  assert.equal(exploded.skills[0].payload, payload);
  assert.equal(exploded.skills[0].description, "Rank.");
});

test("an archive with no SKILL.md anywhere is refused", () => {
  assert.throws(
    () => explodeBundle(zip({ "repo-main/README.md": "# nothing" }), "repo.zip"),
    SkillBundleError,
  );
});

test("a manifest path that escapes the archive is refused", () => {
  assert.throws(
    () =>
      explodeBundle(
        zip({
          "repo-main/digibuddy-skills.json": JSON.stringify({
            skills: [{ name: "demo", path: "../../etc" }],
          }),
          "repo-main/skills/demo/SKILL.md": "# demo",
        }),
        "repo.zip",
      ),
    SkillBundleError,
  );
});

// --- Deployment ------------------------------------------------------------

function store() {
  const documents = new Map<string, unknown>();
  const bundles = new Map<string, Buffer>();
  const revisions = new Map<string, string>();
  let counter = 0;
  return {
    documents,
    bundles,
    async read(name: string) {
      return (documents.get(name) ?? null) as never;
    },
    async readVersioned(name: string) {
      return {
        document: (documents.get(name) ?? null) as never,
        revision: revisions.get(name) ?? "absent",
      };
    },
    async write(name: string, document: unknown, expectedRevision?: string) {
      const current = revisions.get(name) ?? "absent";
      if (expectedRevision !== undefined && expectedRevision !== current) {
        throw new ConfigConflictError(`${name} changed since it was read.`);
      }
      documents.set(name, document);
      const next = `rev-${++counter}`;
      revisions.set(name, next);
      return next;
    },
    async writeBundle(path: string, payload: Buffer) {
      bundles.set(path, payload);
    },
    async deleteBundle(path: string) {
      bundles.delete(path);
    },
  };
}

test("deploying an archive registers every skill it yields", async () => {
  const target = store();
  const result = await deployBundle(
    target as never,
    zip(MATURITY),
    "agent-maturity-main.zip",
    { by: "admin" },
  );

  assert.deepEqual(
    result.skills.map((skill) => skill.name),
    ["agent-maturity-assess", "agent-maturity-report"],
  );
  // Every registry entry must point at a bundle that is actually in the store,
  // or the runtime silently drops the skill.
  for (const skill of result.skills) {
    assert.equal(skill.bundle, `bundles/${skill.name}/${skill.sha256}.zip`);
    assert.ok(target.bundles.has(skill.bundle));
  }
});

test("redeploying bumps the version and keeps the superseded bytes", async () => {
  const target = store();
  const first = await deployBundle(target as never, zip(MATURITY), "a.zip", {
    by: "admin",
  });
  const previousReport = first.skills.find(
    (skill) => skill.name === "agent-maturity-report",
  )!;
  const changed = {
    ...MATURITY,
    "agent-maturity-main/skills/agent-maturity-report/SKILL.md":
      "---\nname: agent-maturity-report\ndescription: Render the report, v2.\n---\n",
  };
  const result = await deployBundle(target as never, zip(changed), "a.zip", {
    by: "admin",
  });

  const report = result.skills.find((skill) => skill.name === "agent-maturity-report")!;
  assert.equal(report.version, "2");
  assert.ok(target.bundles.has(report.bundle));
  // The previous bytes survive, because they are the only thing a rollback
  // could restore.
  assert.notEqual(report.bundle, previousReport.bundle);
  assert.ok(target.bundles.has(previousReport.bundle));
});

test("a registry that moved since it was read is reported, not overwritten", async () => {
  const target = store();
  await deployBundle(target as never, zip(MATURITY), "a.zip", { by: "admin" });

  // Simulate a second administrator saving between this caller's read and write.
  const racing = {
    ...target,
    async readVersioned(name: string) {
      const current = await target.readVersioned(name);
      await target.write(name, current.document, current.revision);
      return current;
    },
  };

  await assert.rejects(
    () => deployBundle(racing as never, zip(MATURITY), "a.zip", { by: "admin" }),
    ConfigConflictError,
  );
});

test("a preview reports the skills without writing anything", () => {
  const preview = previewBundle(zip(MATURITY), "agent-maturity-main.zip");
  assert.equal(preview.layout, "manifest");
  assert.deepEqual(
    preview.skills.map((skill) => skill.name),
    ["agent-maturity-assess", "agent-maturity-report"],
  );
  assert.ok(preview.skills[0].entries.includes("_lib/agent_maturity/cli.py"));
});

// --- URL import ------------------------------------------------------------

const ALLOWED = ["codeload.github.com"];

function fetcher(responses: Record<string, Response>): typeof fetch {
  return (async (input: URL | string) =>
    responses[input.toString()] ??
    new Response(null, { status: 404 })) as unknown as typeof fetch;
}

test("importing is off until an allowlist is configured", async () => {
  await assert.rejects(
    fetchArchive("https://codeload.github.com/a/b/zip/main", { allowed: [] }),
    ConfigValidationError,
  );
});

test("a host outside the allowlist is refused", async () => {
  await assert.rejects(
    fetchArchive("https://evil.example/skills.zip", { allowed: ALLOWED }),
    ConfigValidationError,
  );
});

test("plain HTTP and private addresses are refused", async () => {
  await assert.rejects(
    fetchArchive("http://codeload.github.com/a/b/zip/main", { allowed: ALLOWED }),
    ConfigValidationError,
  );
  // A literal private address is refused even if someone allowlists it, so the
  // console cannot be pointed at the cluster's own network.
  await assert.rejects(
    fetchArchive("https://169.254.169.254/latest/meta-data", {
      allowed: ["169.254.169.254"],
    }),
    ConfigValidationError,
  );
});

test("a redirect off the allowlist is refused rather than followed", async () => {
  const url = "https://codeload.github.com/a/b/zip/main";
  await assert.rejects(
    fetchArchive(url, {
      allowed: ALLOWED,
      fetcher: fetcher({
        [url]: new Response(null, {
          status: 302,
          headers: { location: "https://evil.example/payload.zip" },
        }),
      }),
    }),
    ConfigValidationError,
  );
});

test("an allowed archive is fetched and named after its path", async () => {
  const url = "https://codeload.github.com/haxudev/superclarity/zip/main";
  const payload = zip({ "demo/SKILL.md": "# demo" });
  const archive = await fetchArchive(url, {
    allowed: ALLOWED,
    fetcher: fetcher({ [url]: new Response(new Uint8Array(payload)) }),
  });
  assert.equal(archive.fileName, "main");
  assert.deepEqual(archive.payload, payload);
});
