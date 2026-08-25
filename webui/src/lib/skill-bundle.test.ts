import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { normaliseSkills, ConfigValidationError } from "./admin-config.ts";
import {
  MAX_ENTRIES,
  SkillBundleError,
  explodeBundle,
  inspectBundle,
  nameFromFile,
  type ExplodedBundle,
  type ExplodedCapability,
} from "./skill-bundle.ts";
import { readDirectory, readEntry } from "./zip.ts";
import { zip } from "./zip-fixture.test-helper.ts";

test("a bundle rooted at one directory names itself", () => {
  const payload = zip({ "seo-optimizer/SKILL.md": "# seo", "seo-optimizer/run.py": "1" });
  const inspected = inspectBundle(payload, "upload.zip");
  assert.equal(inspected.name, "seo-optimizer");
  assert.deepEqual(inspected.entries, ["SKILL.md", "run.py"]);
});

test("a flat bundle takes its name from the uploaded file", () => {
  const payload = zip({ "SKILL.md": "# demo" });
  assert.equal(inspectBundle(payload, "Demo-Skill.skill").name, "demo-skill");
});

test("the digest is over the bytes an administrator uploaded", () => {
  const payload = zip({ "demo/SKILL.md": "# demo" });
  assert.equal(
    inspectBundle(payload, "demo.zip").sha256,
    createHash("sha256").update(payload).digest("hex"),
  );
});

test("a bundle without SKILL.md is refused", () => {
  assert.throws(
    () => inspectBundle(zip({ "demo/README.md": "nothing" }), "demo.zip"),
    SkillBundleError,
  );
});

test("traversal and absolute paths are refused", () => {
  assert.throws(
    () => inspectBundle(zip({ "demo/SKILL.md": "#", "demo/../../escape.sh": "boom" }), "demo.zip"),
    SkillBundleError,
  );
  assert.throws(
    () => inspectBundle(zip({ "/etc/passwd": "boom", "SKILL.md": "#" }), "demo.zip"),
    SkillBundleError,
  );
});

test("a symlink entry is refused", () => {
  assert.throws(
    () =>
      inspectBundle(
        zip({ "demo/SKILL.md": "#", "demo/link": "/etc/passwd" }, { symlink: "demo/link" }),
        "demo.zip",
      ),
    SkillBundleError,
  );
});

test("a file that is not a zip is refused", () => {
  assert.throws(() => inspectBundle(Buffer.from("not a zip at all"), "demo.zip"), SkillBundleError);
});

test("an unsuitable skill name is refused", () => {
  assert.throws(() => inspectBundle(zip({ "SKILL.md": "#" }), "Not Valid!.zip"), SkillBundleError);
});

test("nameFromFile strips the archive extension", () => {
  assert.equal(nameFromFile("some/path/Web-Research.SKILL"), "web-research");
});

const digest = "a".repeat(64);

test("the bundle path is always derived, never taken from the request", () => {
  const document = normaliseSkills({
    skills: [{ name: "demo", sha256: digest, bundle: "bundles/demo/../../secrets.zip" }],
  });
  assert.equal(document.skills[0].bundle, `bundles/demo/${digest}.zip`);
});

test("a skill with a bad name or digest is refused", () => {
  assert.throws(
    () => normaliseSkills({ skills: [{ name: "Demo", sha256: digest }] }),
    ConfigValidationError,
  );
  assert.throws(
    () => normaliseSkills({ skills: [{ name: "demo", sha256: "nope" }] }),
    ConfigValidationError,
  );
});

test("duplicate skills are refused so the registry stays unambiguous", () => {
  assert.throws(
    () =>
      normaliseSkills({
        skills: [
          { name: "demo", sha256: digest },
          { name: "demo", sha256: "b".repeat(64) },
        ],
      }),
    ConfigValidationError,
  );
});

// --- Capability packs ------------------------------------------------------

const PACK = {
  "pack-main/digibuddy-skills.json": JSON.stringify({
    schema_version: 1,
    skills: [{ name: "pack-skill", path: "skills/pack-skill" }],
    tools: [
      { name: "pack_tool", path: "tools/pack_tool", module: "pack_tool.cli" },
    ],
    mcp_servers: [
      {
        name: "pack-mcp",
        path: "servers/pack-mcp",
        entrypoint: "server.py",
        runtime: "python",
      },
    ],
  }),
  "pack-main/skills/pack-skill/SKILL.md":
    "---\nname: pack-skill\ndescription: Do a thing.\n---\n",
  "pack-main/tools/pack_tool/__init__.py": "",
  "pack-main/tools/pack_tool/cli.py": "def main():\n    return 0\n",
  "pack-main/servers/pack-mcp/server.py": "print('serving')\n",
};

test("a pack yields one typed artifact per declared capability", () => {
  const exploded = explodeBundle(zip(PACK), "pack-main.zip");

  assert.equal(exploded.layout, "manifest");
  assert.deepEqual(
    exploded.capabilities.map((entry: ExplodedCapability) => [entry.kind, entry.name]),
    [
      ["mcp_server", "pack-mcp"],
      ["skill", "pack-skill"],
      ["tool", "pack_tool"],
    ],
  );
});

test("a tool-only pack is valid, because not every capability is a skill", () => {
  const exploded = explodeBundle(
    zip({
      "t/digibuddy-skills.json": JSON.stringify({
        schema_version: 1,
        tools: [{ name: "solo", path: "tools/solo", module: "solo.cli" }],
      }),
      "t/tools/solo/cli.py": "def main():\n    return 0\n",
    }),
    "t.zip",
  );

  assert.deepEqual(
    exploded.capabilities.map((entry: ExplodedCapability) => entry.kind),
    ["tool"],
  );
});

test("an mcp-only pack is valid too", () => {
  const exploded = explodeBundle(
    zip({
      "m/digibuddy-skills.json": JSON.stringify({
        schema_version: 1,
        mcp_servers: [
          { name: "solo", path: "servers/solo", entrypoint: "main.py" },
        ],
      }),
      "m/servers/solo/main.py": "print('x')\n",
    }),
    "m.zip",
  );

  assert.deepEqual(
    exploded.capabilities.map((entry: ExplodedCapability) => [entry.kind, entry.name]),
    [["mcp_server", "solo"]],
  );
});

test("a declaration pointing outside its own files is refused", () => {
  assert.throws(
    () =>
      explodeBundle(
        zip({
          "p/digibuddy-skills.json": JSON.stringify({
            tools: [{ name: "ghost", path: "tools/missing", module: "ghost" }],
          }),
          "p/tools/other/cli.py": "",
        }),
        "p.zip",
      ),
    SkillBundleError,
  );
});

test("an mcp entrypoint must live inside its own artifact", () => {
  for (const entrypoint of ["/bin/sh", "../escape.py", "sub/../../escape.py"]) {
    assert.throws(
      () =>
        explodeBundle(
          zip({
            "p/digibuddy-skills.json": JSON.stringify({
              mcp_servers: [{ name: "bad", path: "servers/bad", entrypoint }],
            }),
            "p/servers/bad/main.py": "",
          }),
          "p.zip",
        ),
      SkillBundleError,
      `entrypoint ${entrypoint} should be refused`,
    );
  }
});

test("an mcp server may not choose an arbitrary runtime", () => {
  assert.throws(
    () =>
      explodeBundle(
        zip({
          "p/digibuddy-skills.json": JSON.stringify({
            mcp_servers: [
              {
                name: "bad",
                path: "servers/bad",
                entrypoint: "main.py",
                runtime: "/bin/sh",
              },
            ],
          }),
          "p/servers/bad/main.py": "",
        }),
        "p.zip",
      ),
    SkillBundleError,
  );
});

test("an mcp declaration may not carry a literal secret", () => {
  assert.throws(
    () =>
      explodeBundle(
        zip({
          "p/digibuddy-skills.json": JSON.stringify({
            mcp_servers: [
              {
                name: "bad",
                path: "servers/bad",
                entrypoint: "main.py",
                env: { API_TOKEN: "sk-literal-secret" },
              },
            ],
          }),
          "p/servers/bad/main.py": "",
        }),
        "p.zip",
      ),
    SkillBundleError,
  );
});

test("an mcp declaration may not set a reserved variable", () => {
  assert.throws(
    () =>
      explodeBundle(
        zip({
          "p/digibuddy-skills.json": JSON.stringify({
            mcp_servers: [
              {
                name: "bad",
                path: "servers/bad",
                entrypoint: "main.py",
                env: { PYTHONPATH: "/attacker/lib" },
              },
            ],
          }),
          "p/servers/bad/main.py": "",
        }),
        "p.zip",
      ),
    SkillBundleError,
  );
});

test("a manifest written to a newer schema is refused, not guessed at", () => {
  assert.throws(
    () =>
      explodeBundle(
        zip({
          "p/digibuddy-skills.json": JSON.stringify({
            schema_version: 99,
            skills: [{ name: "s", path: "s" }],
          }),
          "p/s/SKILL.md": "---\nname: s\n---\n",
        }),
        "p.zip",
      ),
    SkillBundleError,
  );
});

// --- Self-contained skills -------------------------------------------------

/**
 * The shape of a real capability repository: several skills, one shared Python
 * package they all need, reference data, and a script meant to be run.
 *
 * Modelled on `haxudev/agent-maturity-assessment`, which the image vendors the
 * same way `scripts/sync-agent-skills.sh` does at build time. The point of
 * these tests is that an administrator uploading such a repository gets the
 * same self-contained result the build produces, because a skill whose Python
 * package stayed behind in `src/` fails at the moment the agent runs it.
 */
const REPOSITORY = {
  "amx-main/digibuddy-skills.json": JSON.stringify({
    schema_version: 1,
    skills: [
      { name: "agent-maturity-assess", path: "skills/agent-maturity-assess" },
      { name: "agent-maturity-report", path: "skills/agent-maturity-report" },
    ],
    shared: [{ path: "src/agent_maturity", as: "_lib/agent_maturity" }],
    entrypoints: [{ path: "scripts/amx.py", module: "agent_maturity.cli", call: "main" }],
  }),
  "amx-main/README.md": "# Agent maturity\n",
  "amx-main/pyproject.toml": "[project]\nname = 'agent-maturity-assessment'\n",
  "amx-main/skills/agent-maturity-assess/SKILL.md":
    "---\nname: agent-maturity-assess\ndescription: Run a maturity assessment.\n---\n",
  "amx-main/skills/agent-maturity-assess/references/question-bank.json": '{"schema":"bank/2"}',
  "amx-main/skills/agent-maturity-report/SKILL.md":
    "---\nname: agent-maturity-report\ndescription: Re-render a scored assessment.\n---\n",
  "amx-main/src/agent_maturity/__init__.py": '__version__ = "0.2.0"\n',
  "amx-main/src/agent_maturity/cli.py": "def main():\n    return 0\n",
  "amx-main/src/agent_maturity/mcp/__init__.py": "",
};

function entriesOf(exploded: ExplodedBundle, name: string): string[] {
  const skill = exploded.capabilities.find((entry) => entry.name === name);
  assert.ok(skill, `expected the bundle to yield ${name}`);
  return skill.entries;
}

test("a repository archive explodes into one bundle per skill", () => {
  const exploded = explodeBundle(zip(REPOSITORY), "amx-main.zip");
  assert.equal(exploded.layout, "manifest");
  assert.deepEqual(
    exploded.skills.map((skill) => skill.name),
    ["agent-maturity-assess", "agent-maturity-report"],
  );
});

test("the shared package travels into every skill that needs it", () => {
  // Not a reference to `src/`: each bundle is extracted on its own, so a
  // package left outside it would simply not be there.
  const exploded = explodeBundle(zip(REPOSITORY), "amx-main.zip");
  for (const name of ["agent-maturity-assess", "agent-maturity-report"]) {
    const entries = entriesOf(exploded, name);
    assert.ok(entries.includes("_lib/agent_maturity/cli.py"), name);
    assert.ok(entries.includes("_lib/agent_maturity/__init__.py"), name);
    assert.ok(entries.includes("_lib/agent_maturity/mcp/__init__.py"), name);
  }
});

test("a generated shim makes the script runnable with nothing on PYTHONPATH", () => {
  // This is the Tier 1 contract: the skill carries its own runtime, so it
  // works whether or not an MCP server was ever registered for it.
  const exploded = explodeBundle(zip(REPOSITORY), "amx-main.zip");
  const skill = exploded.capabilities.find(
    (entry) => entry.name === "agent-maturity-assess",
  );
  assert.ok(skill, "expected the assess skill in the bundle");
  assert.ok(skill.entries.includes("scripts/amx.py"));

  const written = readDirectory(skill.payload, MAX_ENTRIES);
  const entry = written.find(
    (item) => item.name === "agent-maturity-assess/scripts/amx.py",
  );
  assert.ok(entry, "expected the generated shim in the bundle");
  const shim = readEntry(skill.payload, entry).toString("utf-8");
  assert.match(shim, /sys\.path\.insert\(0, str\(Path\(__file__\)\.resolve\(\)\.parents\[1\] \/ "_lib"\)\)/);
  assert.match(shim, /from agent_maturity\.cli import main/);
});

test("a skill keeps its own reference data", () => {
  const entries = entriesOf(
    explodeBundle(zip(REPOSITORY), "amx-main.zip"),
    "agent-maturity-assess",
  );
  assert.ok(entries.includes("references/question-bank.json"));
});

test("repository scaffolding is left behind", () => {
  // A skill bundle is the skill, not the repository it came from.
  const entries = entriesOf(
    explodeBundle(zip(REPOSITORY), "amx-main.zip"),
    "agent-maturity-assess",
  );
  assert.equal(entries.includes("README.md"), false);
  assert.equal(entries.includes("pyproject.toml"), false);
  assert.equal(entries.includes("digibuddy-skills.json"), false);
});

test("a shipped script keeps its executable bit", () => {
  // A script that loses it fails when the agent runs it rather than when the
  // bundle is deployed, which is far harder to diagnose.
  const source = {
    "p/digibuddy-skills.json": JSON.stringify({
      schema_version: 1,
      skills: [{ name: "runner", path: "skills/runner" }],
    }),
    "p/skills/runner/SKILL.md": "---\nname: runner\n---\n",
    "p/skills/runner/scripts/run.sh": "#!/bin/sh\necho hi\n",
  };
  const exploded = explodeBundle(
    zip(source, { executable: ["p/skills/runner/scripts/run.sh"] }),
    "p.zip",
  );
  const skill = exploded.capabilities.find((entry) => entry.name === "runner");
  assert.ok(skill);
  const script = readDirectory(skill.payload, MAX_ENTRIES).find(
    (item) => item.name === "runner/scripts/run.sh",
  );
  assert.ok(script, "expected the script to survive explosion");
  assert.ok(script.mode & 0o111, "expected the owner execute bit to survive");
});

test("discovery warns when a shared package would be left behind", () => {
  // The failure this prevents is silent: the skills install looking complete
  // and then fail with ModuleNotFoundError inside a sandbox. This is the shape
  // of `haxudev/agent-maturity-assessment`, whose four skills all import a
  // package that lives in `src/`.
  const exploded = explodeBundle(
    zip({
      "repo-main/skills/one/SKILL.md": "---\nname: one\n---\n",
      "repo-main/skills/two/SKILL.md": "---\nname: two\n---\n",
      "repo-main/src/shared_pkg/__init__.py": "",
      "repo-main/src/shared_pkg/cli.py": "def main():\n    return 0\n",
    }),
    "repo-main.zip",
  );

  assert.equal(exploded.layout, "discovered");
  const warning = exploded.notes.find((note) => note.includes("left behind"));
  assert.ok(warning, "expected a note about the stranded package");
  assert.match(warning, /src\/shared_pkg/);
});

test("a package that lives inside a skill is not reported as stranded", () => {
  // It already travels with the skill, so warning about it would be noise.
  const exploded = explodeBundle(
    zip({
      "repo-main/skills/one/SKILL.md": "---\nname: one\n---\n",
      "repo-main/skills/one/_lib/pkg/__init__.py": "",
    }),
    "repo-main.zip",
  );
  assert.equal(
    exploded.notes.some((note) => note.includes("left behind")),
    false,
  );
});

test("a manifest that vendors the package raises no such warning", () => {
  const exploded = explodeBundle(zip(REPOSITORY), "amx-main.zip");
  assert.equal(
    exploded.notes.some((note) => note.includes("left behind")),
    false,
  );
});
