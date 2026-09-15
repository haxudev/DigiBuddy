import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fixtureDirectory } from "./test-helpers.ts";

const KEYS = ["BFF_ENV_LOCAL", "BFF_ENV_DEFAULT", "BFF_ENV_PRIORITY", "BFF_ENV_SHELL"];

function runLoader(directory: string, mode = "test") {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: mode };
  for (const key of KEYS) delete env[key];
  env.BFF_ENV_SHELL = "shell-value";
  return spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { loadLocalEnvironment } from ${JSON.stringify(new URL("./environment.ts", import.meta.url).href)};
    loadLocalEnvironment(${JSON.stringify(directory)});
    console.log(JSON.stringify(Object.fromEntries(
      ${JSON.stringify(KEYS)}.map((key) => [key, process.env[key] ?? null]),
    )));
  `], { env, encoding: "utf-8" });
}

test("local BFF environment files preserve shell values and prefer .env.local over .env", async (t) => {
  const directory = await fixtureDirectory(t);
  await writeFile(join(directory, ".env.local"), "BFF_ENV_LOCAL=local\nBFF_ENV_PRIORITY=local\nBFF_ENV_SHELL=file-value\n");
  await writeFile(join(directory, ".env"), "BFF_ENV_DEFAULT=default\nBFF_ENV_PRIORITY=default\nBFF_ENV_SHELL=default-value\n");
  const result = runLoader(directory);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    BFF_ENV_LOCAL: "local",
    BFF_ENV_DEFAULT: "default",
    BFF_ENV_PRIORITY: "local",
    BFF_ENV_SHELL: "shell-value",
  });
});

test("production ignores both local BFF environment files", async (t) => {
  const directory = await fixtureDirectory(t);
  await writeFile(join(directory, ".env.local"), "BFF_ENV_LOCAL=local\n");
  await writeFile(join(directory, ".env"), "BFF_ENV_DEFAULT=default\n");
  const result = runLoader(directory, "production");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    BFF_ENV_LOCAL: null,
    BFF_ENV_DEFAULT: null,
    BFF_ENV_PRIORITY: null,
    BFF_ENV_SHELL: "shell-value",
  });
});

test("missing optional environment files do not prevent BFF startup", async (t) => {
  const directory = await fixtureDirectory(t);
  assert.equal(runLoader(directory).status, 0);
  await writeFile(join(directory, ".env"), "BFF_ENV_DEFAULT=default\n");
  const result = runLoader(directory);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).BFF_ENV_DEFAULT, "default");
});

test("environment-file errors other than ENOENT are not hidden", async (t) => {
  const directory = await fixtureDirectory(t);
  await mkdir(join(directory, ".env.local"));
  const result = runLoader(directory);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ERR_INVALID_ARG_TYPE|EISDIR/);
});
