import assert from "node:assert/strict";
import test from "node:test";
import {
  assertAllowedEndpoint,
  latestUserText,
  resolveAuthHeaders,
  resolveConnection,
  responseText,
} from "./agent-proxy.ts";

test("allows Microsoft Foundry endpoints", () => {
  const endpoint = assertAllowedEndpoint(
    "https://demo.services.ai.azure.com/api/projects/app/responses",
    { NODE_ENV: "production" },
  );
  assert.equal(endpoint.hostname, "demo.services.ai.azure.com");
});

test("blocks unlisted production endpoints", () => {
  assert.throws(
    () =>
      assertAllowedEndpoint("https://example.com/responses", {
        NODE_ENV: "production",
      }),
    /not allowed/,
  );
});

test("resolves server defaults without exposing them to the client", () => {
  const connection = resolveConnection(
    {},
    {
      NODE_ENV: "production",
      FOUNDRY_AGENT_ENDPOINT:
        "https://demo.services.ai.azure.com/api/projects/app/responses",
      FOUNDRY_AGENT_API_KEY: "server-key",
      CODEX_MODEL_NAME: "gpt-5.2-codex",
    },
  );
  assert.equal(connection.apiKey, "server-key");
  assert.equal(connection.model, "gpt-5.2-codex");
});

test("uses managed identity when bearer authentication has no static token", async () => {
  const connection = resolveConnection(
    {},
    {
      NODE_ENV: "production",
      FOUNDRY_AGENT_ENDPOINT:
        "https://demo.services.ai.azure.com/api/projects/app/responses",
      FOUNDRY_AUTH_MODE: "bearer",
      CODEX_MODEL_NAME: "gpt-5.6-luna",
    },
  );
  const headers = await resolveAuthHeaders(connection, {
    async getToken(scope) {
      assert.equal(scope, "https://ai.azure.com/.default");
      return { token: "managed-token" };
    },
  });
  assert.deepEqual(headers, { Authorization: "Bearer managed-token" });
});

test("does not let a request opt into the server managed identity", async () => {
  const connection = resolveConnection(
    { connection: { authMode: "bearer" } },
    {
      NODE_ENV: "production",
      FOUNDRY_AGENT_ENDPOINT:
        "https://demo.services.ai.azure.com/api/projects/app/responses",
      CODEX_MODEL_NAME: "gpt-5.6-luna",
    },
  );
  await assert.rejects(
    resolveAuthHeaders(connection, {
      async getToken() {
        throw new Error("managed identity must not be called");
      },
    }),
    /explicit access token/,
  );
});

test("extracts the most recent user message and response output", () => {
  assert.equal(
    latestUserText([
      { id: "1", role: "user", content: "first" },
      { id: "2", role: "assistant", content: "answer" },
      { id: "3", role: "user", content: "latest" },
    ]),
    "latest",
  );
  assert.equal(
    responseText({
      output: [{ content: [{ type: "output_text", text: "done" }] }],
    }),
    "done",
  );
});
