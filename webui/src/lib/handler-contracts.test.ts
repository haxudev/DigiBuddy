/**
 * Contract tests for the handlers a component hands to another component.
 *
 * These exist because of a defect that every other gate missed. A parent passed
 * `createNewSession` to a child as `onClick={onCreate}`, and React handed it a
 * PointerEvent as its first argument -- which the parent had recently given an
 * optional parameter. TypeScript accepted it, because `(p?: string) => void` is
 * assignable to `() => void`. Lint accepted it. The build accepted it. The unit
 * suite never loaded a component at all.
 *
 * The failure then surfaced a turn later inside `structuredClone`, far from the
 * click that caused it.
 *
 * So this file tests the seam rather than the rendering: a callback prop that a
 * child invokes bare must not be a function that reads its first argument.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const COMPONENTS = join(import.meta.dirname, "..", "components");
const PAGE = join(import.meta.dirname, "..", "app", "page.tsx");

function read(path: string): string {
  return readFileSync(path, "utf-8");
}

/** Handlers a component invokes with no arguments of its own. */
function bareInvocations(source: string): string[] {
  // `onClick={someProp}` — React supplies the event as the first argument.
  return [...source.matchAll(/on[A-Z][a-zA-Z]*=\{([a-z][a-zA-Z0-9]*)\}/g)].map(
    (match) => match[1],
  );
}

test("no component hands a bare prop straight to a DOM event", () => {
  const offenders: string[] = [];

  for (const file of readdirSync(COMPONENTS).filter((name) => name.endsWith(".tsx"))) {
    const source = read(join(COMPONENTS, file));
    for (const handler of bareInvocations(source)) {
      // A prop the component received is the risky case: the parent decides
      // what its first parameter means, and the parent cannot see this call.
      const isProp = new RegExp(`\\b${handler}\\b\\s*[,:}]`).test(
        source.split("return")[0] ?? "",
      );
      if (isProp) offenders.push(`${file}: ${handler}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `Wrap these in an arrow so React's event cannot become an argument:\n  ${offenders.join("\n  ")}`,
  );
});

test("the page's own handlers do not take an optional first parameter", () => {
  const source = read(PAGE);
  const risky: string[] = [];

  for (const [, name, params] of source.matchAll(
    /function\s+([a-z][a-zA-Z0-9]*)\s*\(([^)]*)\)/g,
  )) {
    const first = params.split(",")[0]?.trim() ?? "";
    // An optional or defaulted first parameter is what silently absorbs an
    // event object when the function is passed by reference.
    if (!first.includes("=") && !first.startsWith("...") && !first.endsWith("?")) {
      continue;
    }
    const passedByReference = new RegExp(
      `on[A-Z][a-zA-Z]*=\\{${name}\\}`,
    ).test(source);
    if (passedByReference) risky.push(`${name}(${first})`);
  }

  assert.deepEqual(
    risky,
    [],
    `These are passed by reference to a handler prop while accepting an optional first argument:\n  ${risky.join("\n  ")}`,
  );
});
