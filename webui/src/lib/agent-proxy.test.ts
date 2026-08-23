import assert from "node:assert/strict";
import test from "node:test";
import {
  assertAllowedEndpoint,
  latestUserText,
  resolveAuthHeaders,
  resolveConnection,
  responseText,
  responseTextDelta,
  turnInput,
  turnOptions,
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

test("an explicit API key is not reinterpreted by the server auth default", async () => {
  const connection = resolveConnection(
    { connection: { authMode: "api-key", apiKey: "request-key" } },
    {
      NODE_ENV: "production",
      FOUNDRY_AGENT_ENDPOINT:
        "https://demo.services.ai.azure.com/api/projects/app/responses",
      FOUNDRY_AUTH_MODE: "bearer",
      CODEX_MODEL_NAME: "gpt-5.6-luna",
    },
  );

  assert.equal(connection.authMode, "api-key");
  assert.deepEqual(await resolveAuthHeaders(connection), { "api-key": "request-key" });
});

test("does not silently target agent version one", () => {
  assert.throws(
    () =>
      resolveConnection(
        {},
        {
          NODE_ENV: "production",
          FOUNDRY_AGENT_ENDPOINT:
            "https://demo.services.ai.azure.com/api/projects/app/responses",
          FOUNDRY_AGENT_NAME: "digibuddy",
          CODEX_MODEL_NAME: "gpt-5.6-luna",
        },
      ),
    /FOUNDRY_AGENT_VERSION/,
  );
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

test("managed identity cannot be delegated to a request-supplied target", async () => {
  const connection = resolveConnection(
    {
      connection: {
        endpoint:
          "https://other.services.ai.azure.com/api/projects/app/responses",
      },
    },
    {
      NODE_ENV: "production",
      FOUNDRY_AGENT_ENDPOINT:
        "https://demo.services.ai.azure.com/api/projects/app/responses",
      FOUNDRY_AUTH_MODE: "bearer",
      CODEX_MODEL_NAME: "gpt-5.6-luna",
    },
  );

  await assert.rejects(resolveAuthHeaders(connection), /explicit access token/);
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
  assert.equal(
    responseTextDelta("do", {
      output: [{ content: [{ type: "output_text", text: "done" }] }],
    }),
    "ne",
  );
});

test("an unknown thinking strength is dropped", () => {
  assert.equal(turnOptions({ reasoningEffort: "turbo" }).reasoningEffort, "");
  assert.equal(turnOptions({ reasoningEffort: "HIGH" }).reasoningEffort, "high");
  assert.equal(turnOptions(undefined).reasoningEffort, "");
});

test("attachments without inline bytes are dropped", () => {
  const { attachments } = turnOptions({
    attachments: [
      { filename: "a.png", mimeType: "image/png", data: "https://example.com/a.png" },
      { filename: "b.pdf", mimeType: "application/pdf", data: "data:application/pdf;base64,YQ==" },
      "nonsense",
    ],
  });

  assert.deepEqual(attachments.map((item) => item.filename), ["b.pdf"]);
});

test("attachments beyond the size budget are dropped", () => {
  const huge = "data:application/pdf;base64," + "A".repeat(40 * 1024 * 1024);
  const { attachments } = turnOptions({
    attachments: [{ filename: "big.pdf", mimeType: "application/pdf", data: huge }],
  });

  assert.deepEqual(attachments, []);
});

test("a turn without attachments stays a plain string input", () => {
  assert.equal(turnInput("hello", []), "hello");
});

test("images and documents use their own Responses part types", () => {
  const input = turnInput("look", [
    { filename: "a.png", mimeType: "image/png", data: "data:image/png;base64,YQ==" },
    { filename: "b.xlsx", mimeType: "application/vnd.ms-excel", data: "data:x;base64,YQ==" },
  ]) as Array<{ content: Array<Record<string, unknown>> }>;

  assert.deepEqual(
    input[0].content.map((part) => part.type),
    ["input_text", "input_image", "input_file"],
  );
  assert.equal(input[0].content[2].filename, "b.xlsx");
});
