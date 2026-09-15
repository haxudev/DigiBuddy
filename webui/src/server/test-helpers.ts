import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { serve } from "@hono/node-server";
import type { createApp } from "./app.ts";

export function environment(
  t: TestContext,
  overrides: Record<string, string> = {},
) {
  const keys = new Set([
    "NODE_ENV",
    ...Object.keys(process.env).filter((key) =>
      /^(ADMIN_|AUTH_|DIGIBUDDY_|FOUNDRY_|GPT_TRANSCRIBE_|CODEX_MODEL_NAME$|NODE_ENV$)/.test(key),
    ),
    ...Object.keys(overrides),
  ]);
  const original = new Map([...keys].map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, { NODE_ENV: "test" }, overrides);
  t.after(() => {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

export async function fixtureDirectory(t: TestContext) {
  const directory = await mkdtemp(join(import.meta.dirname, ".bff-fixture-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

export function principalHeaders(id = "alice") {
  return {
    "x-ms-client-principal": Buffer.from(JSON.stringify({
      identityProvider: "aad",
      userId: id,
      userDetails: `${id}@example.test`,
    })).toString("base64"),
  };
}

export async function listen(t: TestContext, app: ReturnType<typeof createApp>) {
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }) as Server;
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => error ? reject(error) : resolve());
  }));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No HTTP listener.");
  return `http://127.0.0.1:${address.port}`;
}

export function agentInput(forwardedProps: Record<string, unknown> = {}) {
  return {
    threadId: "contract-thread",
    runId: "contract-run",
    state: { previousResponseId: "previous-response", keep: "client-state" },
    messages: [{ id: "question", role: "user", content: "Hello" }],
    tools: [],
    context: [],
    forwardedProps,
  };
}
