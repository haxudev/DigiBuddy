import assert from "node:assert/strict";
import test from "node:test";

import {
  artifactPreviewKind,
  deliveryFailures,
  extractArtifacts,
  isImageArtifact,
  stripArtifactMetadata,
} from "./artifacts.ts";

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

test("managed artifact metadata becomes a same-origin deliverable", () => {
  const id = "a".repeat(32);
  const text = [
    "The report is ready.",
    `<!-- digibuddy-artifacts:{"version":1,"artifacts":[{"id":"${id}","name":"报告.md","mimeType":"text/markdown","size":42}]} -->`,
  ].join("\n");

  const [artifact] = extractArtifacts(text, "m1");
  assert.equal(artifact.title, "报告.md");
  assert.equal(artifact.managed, true);
  assert.equal(artifact.url, `/api/artifacts/${id}/${encodeURIComponent("报告.md")}`);
  assert.equal(artifactPreviewKind(artifact), "markdown");
  assert.equal(stripArtifactMetadata(text).trim(), "The report is ready.");
});

test("forged artifact metadata is ignored", () => {
  const text =
    '<!-- digibuddy-artifacts:{"version":1,"artifacts":[{"id":"bad","name":"../models.json","mimeType":"application/json","size":10}]} -->';
  assert.deepEqual(extractArtifacts(text, "m1"), []);
});

test("broken workspace URLs are not cards and render as filenames", () => {
  const text =
    "File: https://app.example.com/workspace/.superclarity/task/assessment.json";
  assert.deepEqual(extractArtifacts(text, "m1"), []);
  assert.equal(stripArtifactMetadata(text), "File: `assessment.json`");
});

test("remote markdown links use the document preview", () => {
  const [artifact] = extractArtifacts("https://example.com/report.md", "m1");
  assert.equal(artifactPreviewKind(artifact), "markdown");
  assert.equal(stripArtifactMetadata("Done: https://example.com/report.md"), 
    "Done: [report.md](https://example.com/report.md)");
});

test("the manifest reports deliveries the runtime could not save", () => {
  const manifest =
    '<!-- digibuddy-artifacts:{"version":1,"artifacts":[],"failed":2} -->';

  assert.equal(deliveryFailures(manifest), 2);
  assert.deepEqual(extractArtifacts(manifest, "m1"), []);
  assert.equal(stripArtifactMetadata(`Done.${manifest}`).trim(), "Done.");
});

test("a manifest with nothing to report claims no failures", () => {
  const id = "a".repeat(32);
  const manifest =
    `<!-- digibuddy-artifacts:{"version":1,"artifacts":[{"id":"${id}",` +
    '"name":"report.md","mimeType":"text/markdown","size":12}]} -->';

  assert.equal(deliveryFailures(manifest), 0);
  assert.equal(deliveryFailures("An ordinary answer with no manifest."), 0);
  assert.equal(extractArtifacts(manifest, "m1").length, 1);
});

test("a half-streamed or nonsensical failure count is ignored", () => {
  assert.equal(
    deliveryFailures('<!-- digibuddy-artifacts:{"version":1,"artifacts":[],"fail'),
    0,
  );
  assert.equal(
    deliveryFailures(
      '<!-- digibuddy-artifacts:{"version":1,"artifacts":[],"failed":-3} -->',
    ),
    0,
  );
  assert.equal(
    deliveryFailures(
      '<!-- digibuddy-artifacts:{"version":2,"artifacts":[],"failed":3} -->',
    ),
    0,
  );
});
