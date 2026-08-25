import assert from "node:assert/strict";
import test from "node:test";
import {
  agentRequestBody,
  assertAllowedEndpoint,
  latestUserText,
  resolveAuthHeaders,
  resolveConnection,
  responseErrorMessage,
  responseText,
  responseTextDelta,
  responseTexts,
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

test("keeps each assistant output item a separate reply", () => {
  const payload = {
    output: [
      { content: [{ type: "output_text", text: "first reply" }] },
      { content: [{ type: "output_text", text: "second reply" }] },
    ],
  };
  assert.deepEqual(responseTexts(payload), ["first reply", "second reply"]);
  assert.equal(responseText(payload), "first reply\n\nsecond reply");
  // The streamed prefix carries the same separator, so nothing is replayed.
  assert.equal(responseTextDelta("first reply\n\nsecond", payload), " reply");
});

test("extracts the nested error from a failed Responses event", () => {
  assert.equal(
    responseErrorMessage({
      type: "response.failed",
      response: { error: { message: "Codex turn timed out" } },
    }),
    "Codex turn timed out",
  );
});

test("an unknown thinking strength is dropped", () => {
  assert.equal(turnOptions({ reasoningEffort: "turbo" }).reasoningEffort, "");
  assert.equal(turnOptions({ reasoningEffort: "HIGH" }).reasoningEffort, "high");
  assert.equal(turnOptions({ reasoningEffort: "MAX" }).reasoningEffort, "max");
  assert.equal(turnOptions({ reasoningEffort: "minimal" }).reasoningEffort, "");
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

test("a named agent travels as agent_reference, not the deprecated agent field", () => {
  // The service rejects `agent` with: "The 'agent' property is deprecated.
  // Use 'agent_reference' instead." It only surfaces when a caller names an
  // agent, which is why it sat unnoticed.
  const body = agentRequestBody({
    connection: {
      endpoint: "https://x.services.ai.azure.com/a",
      apiKey: "",
      authMode: "bearer",
      model: "gpt-5.6-luna",
      agentName: "haeronclaw-codex",
      agentVersion: "15",
      profile: "marketing",
      useManagedIdentity: true,
    },
    input: [{ role: "user", content: "hi" }],
    previousResponseId: "",
    reasoningEffort: "",
  });

  assert.equal("agent" in body, false);
  assert.deepEqual(body.agent_reference, {
    type: "agent_reference",
    name: "haeronclaw-codex",
    version: "15",
  });
  assert.deepEqual(body.metadata, { profile: "marketing" });
});

test("an unnamed agent sends no reference at all", () => {
  const body = agentRequestBody({
    connection: {
      endpoint: "https://x.services.ai.azure.com/a",
      apiKey: "",
      authMode: "bearer",
      model: "gpt-5.6-luna",
      agentName: "",
      agentVersion: "",
      profile: "",
      useManagedIdentity: true,
    },
    input: [{ role: "user", content: "hi" }],
    previousResponseId: "",
    reasoningEffort: "",
  });

  assert.equal("agent_reference" in body, false);
  assert.equal("agent" in body, false);
});

test("a hosted agent receives reasoning effort through metadata", () => {
  const body = agentRequestBody({
    connection: {
      endpoint: "https://x.services.ai.azure.com/a",
      apiKey: "",
      authMode: "bearer",
      model: "gpt-5.6-luna",
      agentName: "digibuddy-codex",
      agentVersion: "3",
      profile: "digibuddy",
      useManagedIdentity: true,
    },
    input: [{ role: "user", content: "hi" }],
    previousResponseId: "",
    reasoningEffort: "low",
  });

  assert.equal("reasoning" in body, false);
  assert.deepEqual(body.metadata, {
    profile: "digibuddy",
    reasoning_effort: "low",
  });
});

test("a direct model request keeps the standard reasoning field", () => {
  const body = agentRequestBody({
    connection: {
      endpoint: "https://x.openai.azure.com/openai/v1/responses",
      apiKey: "key",
      authMode: "api-key",
      model: "gpt-5.6-luna",
      agentName: "",
      agentVersion: "",
      profile: "",
      useManagedIdentity: false,
    },
    input: [{ role: "user", content: "hi" }],
    previousResponseId: "",
    reasoningEffort: "high",
  });

  assert.deepEqual(body.reasoning, { effort: "high" });
});

// --- Loading a skill for one turn ------------------------------------------

test("turnOptions reads the skills a slash command named", () => {
  const { skills, command } = turnOptions({
    skills: ["agent-maturity-assess", "agent-maturity-report"],
    command: "agent-adoption-assessment",
  });
  assert.deepEqual(skills, ["agent-maturity-assess", "agent-maturity-report"]);
  assert.equal(command, "agent-adoption-assessment");
});

test("turnOptions drops skill names that are not skill names", () => {
  // The runtime checks these again, but a name that could reach outside a
  // skill directory has no business being forwarded in the first place.
  const { skills } = turnOptions({
    skills: ["fine", "../../etc/passwd", "/absolute", "has space", 7, null],
  });
  assert.deepEqual(skills, ["fine"]);
});

test("turnOptions drops duplicates and folds case", () => {
  const { skills } = turnOptions({ skills: ["Pptx", "pptx"] });
  assert.deepEqual(skills, ["pptx"]);
});

test("turnOptions caps how many skills one turn may load", () => {
  const requested = Array.from({ length: 20 }, (_, index) => `skill-${index}`);
  assert.equal(turnOptions({ skills: requested }).skills.length, 8);
});

test("turnOptions asks for no skills when the composer sent none", () => {
  assert.deepEqual(turnOptions(undefined).skills, []);
  assert.deepEqual(turnOptions({ skills: "not-an-array" }).skills, []);
  assert.equal(turnOptions({}).command, "");
});

test("skills travel as request metadata beside the profile", () => {
  // Metadata values are strings, so the list is comma-separated; the runtime
  // accepts either shape.
  const body = agentRequestBody({
    connection: {
      endpoint: "https://x.services.ai.azure.com/a",
      apiKey: "",
      authMode: "bearer",
      model: "gpt-5.6-luna",
      agentName: "haeronclaw-codex",
      agentVersion: "",
      profile: "marketing",
      useManagedIdentity: true,
    },
    input: "run an assessment",
    previousResponseId: "",
    reasoningEffort: "",
    skills: ["agent-maturity-assess", "agent-maturity-report"],
    command: "agent-adoption-assessment",
  });

  assert.deepEqual(body.metadata, {
    profile: "marketing",
    skills: "agent-maturity-assess,agent-maturity-report",
    command: "agent-adoption-assessment",
  });
});

test("a turn with no command carries no skill metadata", () => {
  // The overwhelming majority of turns are ordinary messages, and they should
  // look on the wire exactly as they did before commands existed.
  const body = agentRequestBody({
    connection: {
      endpoint: "https://x.services.ai.azure.com/a",
      apiKey: "",
      authMode: "bearer",
      model: "gpt-5.6-luna",
      agentName: "haeronclaw-codex",
      agentVersion: "",
      profile: "marketing",
      useManagedIdentity: true,
    },
    input: "hello",
    previousResponseId: "",
    reasoningEffort: "",
  });

  assert.deepEqual(body.metadata, { profile: "marketing" });
});
