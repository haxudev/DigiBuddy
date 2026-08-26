import assert from "node:assert/strict";
import { test } from "node:test";

import { withScriptErrorReporter } from "./artifact-preview.ts";

const DOC = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Report</title></head>
<body><div id="k"></div><script>const top=1;</script></body>
</html>`;

test("the reporter runs before the document's own scripts", () => {
  const out = withScriptErrorReporter(DOC);
  assert.ok(out.indexOf("data-preview-error") < out.indexOf("const top=1"));
});

test("the doctype keeps the first bytes of the document", () => {
  // A document whose first bytes are a `<script>` is parsed in quirks mode,
  // which changes the layout of the page being previewed.
  assert.ok(withScriptErrorReporter(DOC).startsWith("<!doctype html>"));
});

test("a document without a head is anchored on its body", () => {
  const out = withScriptErrorReporter("<!doctype html><html><body><p>hi</p></body></html>");
  assert.ok(out.indexOf("data-preview-error") < out.indexOf("<p>hi</p>"));
  assert.ok(out.startsWith("<!doctype html>"));
});

test("a document with neither head nor body is anchored on its html tag", () => {
  const out = withScriptErrorReporter("<!doctype html><html><p>hi</p></html>");
  assert.ok(out.indexOf("data-preview-error") < out.indexOf("<p>hi</p>"));
  assert.ok(out.startsWith("<!doctype html>"));
});

test("a fragment gets the reporter in front", () => {
  const out = withScriptErrorReporter("<p>hi</p>");
  assert.ok(out.startsWith("<script>"));
  assert.ok(out.endsWith("<p>hi</p>"));
});

test("an empty preview is left alone", () => {
  assert.equal(withScriptErrorReporter(""), "");
  assert.equal(withScriptErrorReporter("   "), "   ");
});

test("the reporter is one complete script element", () => {
  const out = withScriptErrorReporter(DOC);
  const injected = out.slice(out.indexOf("<script>"), out.indexOf("</script>") + 9);
  assert.ok(injected.startsWith("<script>("));
  assert.ok(injected.endsWith("</script>"));
  // Only the closing tag may look like one, or the block would end early and
  // spill the rest of the reporter into the page as text.
  assert.equal(injected.split("</script>").length, 2);
});

test("the document is otherwise untouched", () => {
  const out = withScriptErrorReporter(DOC);
  assert.ok(out.includes('<div id="k"></div>'));
  assert.ok(out.includes("<title>Report</title>"));
  assert.equal(out.replace(/<script>\(function\(\)\{[\s\S]*?\}\)\(\);<\/script>/, ""), DOC);
});
