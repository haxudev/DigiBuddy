import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

// A report is charts and tables, so its scripts have to run. Both places that
// render one are one attribute away from either a blank page or an untrusted
// document with this app's cookies, and neither mistake announces itself: the
// page simply shows nothing, or shows everything.

const source = (path: string) =>
  readFileSync(join(process.cwd(), "src", path), "utf8");

test("a delivered report may run its own scripts", () => {
  assert.match(
    source("components/ArtifactWindow.tsx"),
    /sandbox="allow-scripts"\s*\n\s*srcDoc=\{previewContent\}/,
  );
});

test("a delivered report never gets this app's origin", () => {
  // `allow-scripts` together with `allow-same-origin` is the same as no
  // sandbox at all: the document could read the session cookie and call the
  // API as the signed-in user.
  for (const [, tokens] of source("components/ArtifactWindow.tsx").matchAll(
    /sandbox="([^"]*)"/g,
  )) {
    assert.doesNotMatch(tokens, /allow-same-origin/);
  }
});

test("a delivered report cannot reach the network", () => {
  // Denying the network is what makes running its scripts safe: a page that
  // can fetch is a page that can send what it is displaying somewhere.
  const csp = source("app/api/artifacts/[id]/[name]/route.ts");
  assert.match(csp, /sandbox allow-scripts/);
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'unsafe-inline'/);
  assert.doesNotMatch(csp, /connect-src/);
});

test("the preview holds a report that carries its own charting library", () => {
  const window = source("components/ArtifactWindow.tsx");
  const match = window.match(/MAX_TEXT_PREVIEW_BYTES = (\d+) \* 1024 \* 1024/);
  assert.ok(match, "the preview ceiling should stay expressed in megabytes");
  assert.ok(
    Number(match[1]) >= 4,
    "ECharts alone is over a megabyte before any report content",
  );
});
