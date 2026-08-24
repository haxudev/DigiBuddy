import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { normaliseSkills, ConfigValidationError } from "./admin-config.ts";
import {
  SkillBundleError,
  explodeBundle,
  inspectBundle,
  nameFromFile,
  type ExplodedCapability,
} from "./skill-bundle.ts";
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
