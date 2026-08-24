import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { normaliseSkills, ConfigValidationError } from "./admin-config.ts";
import { SkillBundleError, inspectBundle, nameFromFile } from "./skill-bundle.ts";
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
