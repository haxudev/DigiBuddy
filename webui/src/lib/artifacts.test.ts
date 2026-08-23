import assert from "node:assert/strict";
import test from "node:test";

import { extractArtifacts, isImageArtifact } from "./artifacts.ts";

test("named code blocks become deliverables", () => {
  const text = ['```html title=report.html', "<h1>Report</h1>", "```"].join("\n");
  const [artifact] = extractArtifacts(text, "m1");
  assert.equal(artifact.kind, "html");
  assert.equal(artifact.title, "report.html");
  assert.equal(artifact.content.trim(), "<h1>Report</h1>");
});

test("short unnamed snippets are not treated as deliverables", () => {
  assert.deepEqual(extractArtifacts("```bash\nnpm test\n```", "m1"), []);
});

test("long unnamed code blocks are kept", () => {
  const body = Array.from({ length: 9 }, (_, index) => `line ${index}`).join("\n");
  const [artifact] = extractArtifacts(`\`\`\`python\n${body}\n\`\`\``, "m1");
  assert.equal(artifact.kind, "code");
  assert.equal(artifact.language, "python");
});

test("ask-user blocks are never deliverables", () => {
  assert.deepEqual(
    extractArtifacts('```ask-user\n{"question":"Pick","options":["a"]}\n```', "m1"),
    [],
  );
});

test("download links with a known file type become deliverables", () => {
  const text =
    "Done: https://acct.blob.core.windows.net/out/deck.pptx?sv=2024-01-01&sig=abc and https://example.com/docs.";
  const artifacts = extractArtifacts(text, "m1");
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].kind, "link");
  assert.equal(artifacts[0].title, "deck.pptx");
  assert.equal(artifacts[0].language, "pptx");
  assert.ok(artifacts[0].url.endsWith("sig=abc"));
});

test("duplicate links are collapsed", () => {
  const url = "https://example.com/a/report.pdf";
  assert.equal(extractArtifacts(`${url} then ${url}`, "m1").length, 1);
});

test("images are flagged for inline preview", () => {
  const [artifact] = extractArtifacts("https://example.com/chart.png", "m1");
  assert.ok(isImageArtifact(artifact));
});
