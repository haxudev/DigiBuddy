import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const root = fileURLToPath(new URL("./", import.meta.url));

async function browserBuild(source: string) {
  return build({
    root,
    configFile: fileURLToPath(new URL("./vite.config.ts", import.meta.url)),
    logLevel: "silent",
    publicDir: false,
    plugins: [{
      name: "browser-boundary-probe",
      resolveId(id) {
        if (id === "virtual:boundary-probe") return "\0boundary-probe";
      },
      load(id) {
        if (id === "\0boundary-probe") return source;
      },
    }],
    build: {
      write: false,
      rollupOptions: { input: "virtual:boundary-probe" },
    },
  });
}

test("browser bundles cannot import server libraries, even for a constant", async () => {
  await assert.rejects(
    browserBuild(
      'import { MAX_ATTACHMENT_BYTES } from "/src/server/lib/agent-proxy.ts"; console.log(MAX_ATTACHMENT_BYTES);',
    ),
    /Server-only code cannot be imported by the SPA/,
  );
});

test("neither server environment nor VITE-prefixed values are bundled", async (t) => {
  const names = ["FOUNDRY_AGENT_API_KEY", "VITE_FOUNDRY_AGENT_API_KEY"];
  const previous = names.map((name) => process.env[name]);
  t.after(() => names.forEach((name, index) => {
    if (previous[index] === undefined) delete process.env[name];
    else process.env[name] = previous[index];
  }));
  for (const name of names) process.env[name] = "migration-build-boundary-sentinel";

  const result = await browserBuild("console.log(import.meta.env);");
  assert.ok(!("on" in result), "this is a one-shot build, not a watcher");
  const builds = Array.isArray(result) ? result : [result];
  const chunks = builds.flatMap((entry) => entry.output);
  assert.ok(chunks.some((chunk) => chunk.type === "chunk"));
  for (const chunk of chunks) {
    if (chunk.type === "chunk") {
      assert.doesNotMatch(chunk.code, /migration-build-boundary-sentinel|FOUNDRY_AGENT_API_KEY/);
    }
  }
});
