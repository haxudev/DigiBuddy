import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import test from "node:test";
import { createApp } from "./app.ts";
import { agentInput, environment, listen, principalHeaders } from "./test-helpers.ts";

const UPSTREAM = "https://fixture.services.ai.azure.com/responses";
const encoder = new TextEncoder();
const frame = (event: Record<string, unknown>) => `data: ${JSON.stringify(event)}\n\n`;

function events(text: string): Record<string, unknown>[] {
  return text.split(/\r?\n\r?\n/)
    .filter((block) => block.startsWith("data: "))
    .map((block) => JSON.parse(block.slice(6)) as Record<string, unknown>);
}

test("HTTP SSE is delivered incrementally with start, text, state and finish events", { timeout: 5000 }, async (t) => {
  environment(t, { FOUNDRY_AGENT_ENDPOINT: UPSTREAM, CODEX_MODEL_NAME: "fixture-model" });
  const realFetch = globalThis.fetch;
  let upstreamController!: ReadableStreamDefaultController<Uint8Array>;
  let upstreamStarted!: () => void;
  const started = new Promise<void>((resolve) => { upstreamStarted = resolve; });
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(input) !== UPSTREAM) return realFetch(input, init);
    assert.equal(init?.method, "POST");
    assert.equal(new Headers(init?.headers).get("accept"), "text/event-stream");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.previous_response_id, "previous-response");
    assert.equal(body.stream, true);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { upstreamController = controller; },
    });
    upstreamStarted();
    return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
  });
  const base = await listen(t, createApp());
  const response = await fetch(base + "/api/agent", {
    method: "POST", headers: principalHeaders(), body: JSON.stringify(agentInput()),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /^text\/event-stream/);
  assert.equal(response.headers.get("cache-control"), "no-cache, no-store");
  assert.equal(response.headers.get("x-accel-buffering"), "no");
  assert.equal(response.headers.get("content-encoding"), null);
  assert.equal(response.headers.get("content-length"), null);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = decoder.decode((await reader.read()).value);
  assert.deepEqual(events(text).map((event) => event.type), ["RUN_STARTED"]);
  await started;
  const streamed = encoder.encode(
    frame({ type: "response.created", response: { id: "response-next" } }) +
    frame({ type: "response.output_text.delta", item_id: "reply", delta: "Hello 世界" }),
  );
  // Split inside a multibyte code point as a real transport is allowed to do.
  const boundary = streamed.indexOf(0xe4) + 1;
  upstreamController.enqueue(streamed.slice(0, boundary));
  upstreamController.enqueue(streamed.slice(boundary));
  while (!text.includes("TEXT_MESSAGE_CONTENT")) {
    text += decoder.decode((await reader.read()).value, { stream: true });
  }
  assert.equal(events(text).find((event) => event.type === "TEXT_MESSAGE_CONTENT")?.delta, "Hello 世界");
  assert.equal(text.includes("RUN_FINISHED"), false);
  upstreamController.enqueue(encoder.encode(frame({
    type: "response.completed",
    response: { id: "response-next", output: [{ content: [{ type: "output_text", text: "Hello 世界" }] }] },
  })));
  upstreamController.close();
  while (true) {
    const { value, done } = await reader.read();
    text += decoder.decode(value, { stream: !done });
    if (done) break;
  }
  const all = events(text);
  assert.deepEqual(all.filter((event) => event.type !== "CUSTOM").map((event) => event.type), [
    "RUN_STARTED", "TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END",
    "STATE_SNAPSHOT", "RUN_FINISHED",
  ]);
  assert.deepEqual(all.find((event) => event.type === "STATE_SNAPSHOT")?.snapshot, {
    previousResponseId: "response-next", keep: "client-state",
  });
  assert.equal(all.at(-1)?.threadId, "contract-thread");
  assert.equal(all.at(-1)?.runId, "contract-run");
});

test("SSE keepalives continue while the upstream is waiting and stop after completion", async (t) => {
  environment(t, { FOUNDRY_AGENT_ENDPOINT: UPSTREAM, CODEX_MODEL_NAME: "fixture-model" });
  t.mock.timers.enable({ apis: ["setInterval"] });
  let complete!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => { complete = resolve; });
  t.mock.method(globalThis, "fetch", () => pending);
  const response = await createApp().request("/api/agent", {
    method: "POST", headers: principalHeaders(), body: JSON.stringify(agentInput()),
  });
  const reader = response.body!.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /RUN_STARTED/);
  t.mock.timers.tick(15_000);
  assert.equal(new TextDecoder().decode((await reader.read()).value), ": keep-alive\n\n");
  t.mock.timers.tick(15_000);
  assert.equal(new TextDecoder().decode((await reader.read()).value), ": keep-alive\n\n");
  complete(Response.json({
    id: "complete", output: [{ content: [{ type: "output_text", text: "Done" }] }],
  }));
  let rest = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    rest += new TextDecoder().decode(value);
  }
  assert.match(rest, /RUN_FINISHED/);
  t.mock.timers.tick(30_000);
  assert.equal((await reader.read()).done, true);
});

test("upstream HTTP and SSE failures retain RUN_ERROR instead of a false finish", async (t) => {
  environment(t, { FOUNDRY_AGENT_ENDPOINT: UPSTREAM, CODEX_MODEL_NAME: "fixture-model" });
  for (const upstream of [
    Response.json({ error: { message: "Upstream fixture unavailable" } }, { status: 503 }),
    new Response(frame({
      type: "response.failed", response: { error: { message: "Upstream fixture unavailable" } },
    }), { headers: { "Content-Type": "text/event-stream" } }),
  ]) {
    const mock = t.mock.method(globalThis, "fetch", async () => upstream);
    const response = await createApp().request("/api/agent", {
      method: "POST", headers: principalHeaders(), body: JSON.stringify(agentInput()),
    });
    const all = events(await response.text());
    assert.equal(all[0].type, "RUN_STARTED");
    assert.equal(all.at(-1)?.type, "RUN_ERROR");
    assert.equal(all.at(-1)?.message, "Upstream fixture unavailable");
    assert.equal(all.at(-1)?.code, "UPSTREAM_ERROR");
    assert.equal(all.some((event) => event.type === "RUN_FINISHED"), false);
    mock.mock.restore();
  }
});

test("a real client socket disconnect aborts the pending upstream fetch and its stream", { timeout: 5000 }, async (t) => {
  environment(t, { CODEX_MODEL_NAME: "fixture-model", FOUNDRY_AGENT_ENDPOINT: "" });
  let reached!: () => void;
  const upstreamReached = new Promise<void>((resolve) => { reached = resolve; });
  let upstreamClosed!: () => void;
  const closed = new Promise<void>((resolve) => { upstreamClosed = resolve; });
  const upstreamApp = createApp();
  upstreamApp.post("/responses", (context) => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        context.req.raw.signal.addEventListener("abort", () => {
          upstreamClosed();
          try { controller.close(); } catch { /* Already cancelled by the adapter. */ }
        }, { once: true });
        controller.enqueue(encoder.encode(": upstream waiting\n\n"));
        reached();
      },
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
  });
  const upstreamBase = await listen(t, upstreamApp);
  process.env.FOUNDRY_AGENT_ENDPOINT = upstreamBase + "/responses";
  const realFetch = globalThis.fetch;
  let aborted!: () => void;
  const abortedFetch = new Promise<void>((resolve) => { aborted = resolve; });
  let upstreamSignal: AbortSignal | undefined;
  t.mock.method(globalThis, "fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    assert.equal(String(input), upstreamBase + "/responses");
    assert.ok(init?.signal);
    upstreamSignal = init.signal;
    init.signal.addEventListener("abort", aborted, { once: true });
    return realFetch(input, init);
  });
  const base = await listen(t, createApp());
  const downstream = httpRequest(base + "/api/agent", {
    method: "POST", headers: { ...principalHeaders(), "Content-Type": "application/json" },
  });
  t.after(() => downstream.destroy());
  const firstEvent = new Promise<void>((resolve, reject) => {
    downstream.on("error", reject);
    downstream.on("response", (response) => {
      response.on("error", () => {});
      response.on("data", (chunk: Buffer) => {
        if (chunk.toString().includes("RUN_STARTED")) resolve();
      });
    });
  });
  downstream.end(JSON.stringify(agentInput()));
  await Promise.all([firstEvent, upstreamReached]);
  assert.equal(upstreamSignal?.aborted, false);
  downstream.destroy();
  await Promise.all([abortedFetch, closed]);
  assert.equal(upstreamSignal?.aborted, true);
});
