import assert from "node:assert/strict";
import { randomBytes, scryptSync } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { ManagedIdentityCredential } from "@azure/identity";
import { apiRoutes, createApp } from "./app.ts";
import { buildConfigStore, DOCUMENTS } from "./lib/admin-config.ts";
import { ownerKey } from "./lib/identity.ts";
import { MAX_ARTIFACT_BYTES } from "../lib/artifacts.ts";
import { MAX_TRANSCRIPTION_BYTES } from "./lib/transcription.ts";
import {
  agentInput,
  environment,
  fixtureDirectory,
  listen,
  principalHeaders,
} from "./test-helpers.ts";

const ROUTES: Record<string, string[]> = {
  "/api/agent": ["POST"],
  "/api/me": ["GET"],
  "/api/profiles": ["GET"],
  "/api/commands": ["GET"],
  "/api/artifacts/:id/:name": ["GET"],
  "/api/transcribe": ["POST"],
  "/api/admin/session": ["DELETE", "GET", "POST"],
  "/api/admin/config": ["GET", "PUT"],
  "/api/admin/credentials": ["GET", "PUT"],
  "/api/admin/commands": ["DELETE", "GET", "PATCH", "PUT"],
  "/api/admin/skill-policy": ["GET", "PATCH", "PUT"],
  "/api/admin/skills": ["DELETE", "GET", "PATCH", "POST"],
  "/api/admin/skills/import": ["POST"],
  "/api/admin/skills/preview": ["GET", "POST"],
  "/api/runtime/documents/:name": ["GET", "PUT"],
  "/api/runtime/bundles/:name/:sha256": ["GET"],
  "/api/runtime/artifacts/:owner/:id/:name": ["PUT"],
};

test("all 17 paths and 31 methods retain automatic OPTIONS, Allow, HEAD and 405", async (t) => {
  const directory = await fixtureDirectory(t);
  environment(t, { DIGIBUDDY_CONFIG_DIR: directory });
  t.mock.method(console, "warn", () => {});
  const app = createApp();
  const base = await listen(t, app);
  assert.deepEqual(Object.fromEntries(apiRoutes.map(({ path, methods }) =>
    [path, [...methods].sort()])), ROUTES);
  assert.equal(apiRoutes.reduce((total, entry) => total + entry.methods.length, 0), 31);
  for (const [path, methods] of Object.entries(ROUTES)) {
    const concrete = path.replace(/:[^/]+/g, "fixture");
    const allowed = [...methods, "OPTIONS", ...(methods.includes("GET") ? ["HEAD"] : [])].sort();
    for (const suffix of ["", "/"]) {
      const response = await fetch(base + concrete + suffix, { method: "OPTIONS" });
      assert.equal(response.status, 204, concrete);
      assert.equal(response.headers.get("allow"), allowed.join(", "), concrete);
      assert.equal(response.headers.get("access-control-allow-origin"), null);
      assert.equal(await response.text(), "");
    }
    const unsupported = await app.request(concrete, { method: "PROPFIND" });
    assert.equal(unsupported.status, 405, concrete);
    assert.equal(await unsupported.text(), "");
    const head = await fetch(base + concrete, { method: "HEAD" });
    const get = await fetch(base + concrete);
    assert.equal(head.status, methods.includes("GET") ? get.status : 405, concrete);
    assert.equal(await head.text(), "");
    await get.arrayBuffer();
  }
});

test("all original methods dispatch to their existing authentication boundary", async (t) => {
  const directory = await fixtureDirectory(t);
  environment(t, { DIGIBUDDY_CONFIG_DIR: directory });
  const app = createApp();
  t.mock.method(console, "warn", () => {});
  for (const [path, methods] of Object.entries(ROUTES)) {
    const concrete = path.replace(/:[^/]+/g, "fixture");
    for (const method of methods) {
      const response = await app.request(concrete, { method });
      const expected = path === "/api/me" || path === "/api/profiles" ? 200
        : path === "/api/admin/session" ? method === "DELETE" ? 200 : 401
        : path.startsWith("/api/runtime/") ? 401 : 403;
      assert.equal(response.status, expected, `${method} ${path}`);
      await response.arrayBuffer();
    }
  }
});

test("the maintained HTTP adapter preserves request URL, headers, bytes, status and separate cookies", async (t) => {
  const app = createApp();
  app.post("/contract/echo", async (context) => {
    const request = context.req.raw;
    assert.equal(new URL(request.url).pathname, "/contract/echo");
    assert.equal(new URL(request.url).search, "?value=a%2Fb&value=%2B");
    assert.equal(request.headers.get("x-ms-client-principal"), principalHeaders()["x-ms-client-principal"]);
    assert.equal(request.headers.get("cookie"), "one=1; two=2");
    const headers = new Headers({
      "Content-Type": "application/octet-stream",
      "Cache-Control": "private, no-store",
      "X-Original": "preserved",
    });
    headers.append("Set-Cookie", "first=1; Path=/; HttpOnly");
    headers.append("Set-Cookie", "second=2; Path=/; SameSite=Strict");
    return new Response(await request.arrayBuffer(), { status: 207, headers });
  });
  const base = await listen(t, app);
  const body = new Uint8Array([0, 1, 255, 10]);
  const response = await fetch(base + "/contract/echo?value=a%2Fb&value=%2B", {
    method: "POST",
    headers: { ...principalHeaders(), Cookie: "one=1; two=2" },
    body,
  });
  assert.equal(response.status, 207);
  assert.equal(response.headers.get("x-original"), "preserved");
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(response.headers.getSetCookie(), [
    "first=1; Path=/; HttpOnly",
    "second=2; Path=/; SameSite=Strict",
  ]);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), body);
});

test("only known SPA GET/HEAD routes fall back; static content cannot shadow API or Easy Auth", async (t) => {
  const root = await fixtureDirectory(t);
  const dist = join(root, "dist");
  await mkdir(join(dist, "assets"), { recursive: true });
  await mkdir(join(dist, "api"), { recursive: true });
  await mkdir(join(dist, ".auth"), { recursive: true });
  await writeFile(join(dist, "index.html"), "<html>SPA fixture</html>");
  await writeFile(join(dist, "assets", "app.js"), "export const fixture = true;");
  await writeFile(join(dist, "api", "unknown"), "must not be served");
  await writeFile(join(dist, ".auth", "login"), "must not be served");
  await writeFile(join(root, "private.txt"), "outside static root");
  const base = await listen(t, createApp({ staticRoot: dist }));
  for (const path of ["/", "/admin", "/admin/"]) {
    const get = await fetch(base + path);
    assert.equal(get.status, 200, path);
    assert.equal(await get.text(), "<html>SPA fixture</html>");
    const head = await fetch(base + path, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    assert.equal((await fetch(base + path, { method: "POST" })).status, 404);
  }
  const asset = await fetch(base + "/assets/app.js");
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get("content-type") || "", /javascript/);
  await asset.text();
  for (const path of ["/unknown", "/admin/unknown", "/api", "/api/unknown",
    "/.auth", "/.auth/login", "/.auth/me", "/private.txt", "/src/server/index.ts",
    "/assets/%2e%2e/%2e%2e/private.txt"]) {
    const response = await fetch(base + path);
    assert.equal(response.status, 404, path);
    assert.doesNotMatch(await response.text(), /SPA fixture|outside static root|must not be served/);
  }
});

test("unexpected errors expose a generic response without the exception's details", async (t) => {
  t.mock.method(console, "error", () => {});
  const app = createApp();
  const sensitive = randomBytes(24).toString("hex");
  app.get("/contract/failure", () => { throw new Error(sensitive); });
  const base = await listen(t, app);
  const response = await fetch(base + "/contract/failure");
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "Internal server error." });
});

test("me and agent use the platform principal, never body-supplied owners", async (t) => {
  environment(t, {
    FOUNDRY_AGENT_ENDPOINT: "https://fixture.services.ai.azure.com/responses",
    CODEX_MODEL_NAME: "fixture-model",
  });
  const expectedOwner = ownerKey({ id: "alice", name: "alice@example.test", provider: "aad" });
  const app = createApp();
  assert.equal((await (await app.request("/api/me")).json()).signedIn, false);
  const me = await app.request("/api/me?owner=mallory", { headers: principalHeaders() });
  assert.equal(me.headers.get("cache-control"), "no-store");
  assert.deepEqual(await me.json(), {
    signedIn: true, name: "alice@example.test", provider: "aad", owner: expectedOwner,
    providers: ["aad"], corporateOnly: false,
  });
  let upstreamOwner = "";
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    upstreamOwner = JSON.parse(String(init?.body)).metadata.owner;
    return Response.json({ id: "response", output: [{ content: [{ type: "output_text", text: "Hello" }] }] });
  });
  const body = JSON.stringify({ ...agentInput({ owner: "mallory" }), owner: "mallory" });
  assert.equal((await app.request("/api/agent", { method: "POST", body })).status, 403);
  const response = await app.request("/api/agent", {
    method: "POST", headers: principalHeaders(), body,
  });
  await response.text();
  assert.equal(upstreamOwner, expectedOwner);
  for (const invalid of ["{", "{}"]) {
    assert.equal((await app.request("/api/agent", {
      method: "POST", headers: principalHeaders(), body: invalid,
    })).status, 400);
  }
});

test("artifact params, owner isolation, private headers, CSP and download query survive HTTP", async (t) => {
  const directory = await fixtureDirectory(t);
  environment(t, { DIGIBUDDY_CONFIG_DIR: directory });
  const store = buildConfigStore();
  const owner = ownerKey({ id: "alice", name: "alice@example.test", provider: "aad" });
  const id = "a".repeat(32);
  const name = "résumé.pdf";
  const payload = Buffer.from("%PDF-1.7 fixture");
  await store.writeArtifact(id, name, payload, "application/pdf", owner);
  await store.writeArtifact(id, "report.html", Buffer.from("<h1>private</h1>"), "text/html", owner);
  const base = await listen(t, createApp());
  const path = `/api/artifacts/${id}/${encodeURIComponent(name)}`;
  assert.equal((await fetch(base + path)).status, 403);
  assert.equal((await fetch(base + path, { headers: principalHeaders("bob") })).status, 404);
  const response = await fetch(base + path, { headers: principalHeaders() });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control") || "", /^private, .*immutable/);
  assert.equal(response.headers.get("content-length"), String(payload.length));
  assert.equal(response.headers.get("content-type"), "application/pdf");
  assert.equal(response.headers.get("cross-origin-resource-policy"), "same-origin");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.match(response.headers.get("content-disposition") || "", /^inline;.*filename\*=UTF-8''r%C3%A9sum%C3%A9.pdf$/);
  const csp = response.headers.get("content-security-policy") || "";
  assert.match(csp, /sandbox allow-scripts; default-src 'none'/);
  assert.doesNotMatch(csp, /allow-same-origin/);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), payload);
  const download = await fetch(base + path + "?download=1", { headers: principalHeaders() });
  assert.match(download.headers.get("content-disposition") || "", /^attachment;/);
  await download.arrayBuffer();
  const html = await fetch(base + `/api/artifacts/${id}/report.html`, { headers: principalHeaders() });
  assert.match(html.headers.get("content-disposition") || "", /^attachment;/);
  await html.text();
  const head = await fetch(base + path, { method: "HEAD", headers: principalHeaders() });
  assert.equal(head.headers.get("content-length"), String(payload.length));
  assert.equal(await head.text(), "");
});

test("runtime secret, immutable document whitelist, bundle bytes and owner artifact upload", async (t) => {
  const directory = await fixtureDirectory(t);
  const secret = randomBytes(32).toString("hex");
  environment(t, { DIGIBUDDY_CONFIG_DIR: directory, DIGIBUDDY_RUNTIME_SHARED_SECRET: secret });
  t.mock.method(console, "warn", () => {});
  const headers = { "x-digibuddy-runtime-secret": secret };
  const app = createApp();
  const base = await listen(t, app);
  const store = buildConfigStore();
  for (const document of DOCUMENTS) await store.write(document, { fixture: document });
  const url = base + "/api/runtime/documents/models.json";
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { headers: principalHeaders() })).status, 401);
  assert.equal((await fetch(url, { headers: { "x-digibuddy-runtime-secret": "incorrect" } })).status, 401);
  for (const document of DOCUMENTS) {
    const response = await fetch(base + `/api/runtime/documents/${document}`, { headers });
    assert.equal(response.status, 200, document);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { fixture: document });
    const write = await fetch(base + `/api/runtime/documents/${document}`, {
      method: "PUT", headers, body: JSON.stringify({ fixture: "replacement" }),
    });
    assert.equal(write.status, document === "catalogue.json" ? 204 : 400, document);
  }
  assert.deepEqual(await store.read("models.json"), { fixture: "models.json" });
  assert.equal((await fetch(base + "/api/runtime/documents/private.json", { headers })).status, 400);
  const digest = "b".repeat(64);
  const bytes = Buffer.from([80, 75, 0, 1, 255]);
  await store.writeBundle(`bundles/demo/${digest}.zip`, bytes);
  const bundle = await fetch(base + `/api/runtime/bundles/demo/${digest}.zip`, { headers });
  assert.equal(bundle.status, 200);
  assert.deepEqual(Buffer.from(await bundle.arrayBuffer()), bytes);
  const owner = "c".repeat(32);
  const id = "d".repeat(32);
  const upload = await fetch(base + `/api/runtime/artifacts/${owner}/${id}/file.txt`, {
    method: "PUT", headers: { ...headers, "Content-Type": "text/plain" }, body: "artifact bytes",
  });
  assert.equal(upload.status, 204);
  assert.equal((await store.readArtifact(id, "file.txt", owner))?.toString(), "artifact bytes");
});

test("production administrator cookies, redacted config, credential rotation and logout are preserved", async (t) => {
  const directory = await fixtureDirectory(t);
  const password = randomBytes(24).toString("hex");
  const salt = randomBytes(16);
  const digest = scryptSync(password, salt, 32, { N: 1024, r: 8, p: 1 });
  environment(t, {
    NODE_ENV: "production",
    DIGIBUDDY_CONFIG_DIR: directory,
    ADMIN_ALLOW_ANONYMOUS: "true",
    ADMIN_USERNAME: "fixture-admin",
    ADMIN_PASSWORD_HASH: `scrypt$1024$8$1$${salt.toString("base64url")}$${digest.toString("base64url")}`,
    ADMIN_SESSION_SECRET: randomBytes(32).toString("hex"),
  });
  const modelKey = randomBytes(24).toString("hex");
  const credential = randomBytes(24).toString("hex");
  const store = buildConfigStore();
  await store.write("models.json", {
    model: "fixture", endpoint: "https://fixture.openai.azure.com", api_key: modelKey,
  });
  const base = await listen(t, createApp());
  assert.equal((await fetch(base + "/api/admin/session")).status, 401);
  assert.equal((await fetch(base + "/api/admin/config")).status, 403);
  const rejected = await fetch(base + "/api/admin/session", {
    method: "POST", body: JSON.stringify({ username: "fixture-admin", password: "wrong" }),
  });
  assert.equal(rejected.status, 401);
  assert.deepEqual(rejected.headers.getSetCookie(), []);
  const login = await fetch(base + "/api/admin/session", {
    method: "POST", body: JSON.stringify({ username: "fixture-admin", password }),
  });
  assert.equal(login.status, 200);
  const cookies = login.headers.getSetCookie();
  assert.equal(cookies.length, 1);
  assert.match(cookies[0], /; Path=\/; HttpOnly; SameSite=Strict; Max-Age=28800; Secure$/);
  const headers = { Cookie: cookies[0].split(";")[0] };
  const session = await fetch(base + "/api/admin/session", { headers });
  assert.deepEqual(await session.json(), { authenticated: true, name: "fixture-admin" });
  const config = await fetch(base + "/api/admin/config", { headers });
  const configText = await config.text();
  assert.equal(config.status, 200);
  assert.equal(config.headers.get("cache-control"), "no-store");
  assert.equal(configText.includes(modelKey), false);
  const rotated = await fetch(base + "/api/admin/credentials", {
    method: "PUT", headers,
    body: JSON.stringify({ profile: "digibuddy", slot: "graph_client_secret", value: credential }),
  });
  assert.equal(rotated.status, 200);
  assert.equal((await rotated.text()).includes(credential), false);
  const statuses = await fetch(base + "/api/admin/credentials", { headers });
  const statusText = await statuses.text();
  assert.equal(statuses.status, 200);
  assert.equal(statusText.includes(credential), false);
  assert.equal(statusText.includes('"is_set":true'), true);
  const logout = await fetch(base + "/api/admin/session", { method: "DELETE", headers });
  assert.match(logout.headers.getSetCookie()[0], /Max-Age=0; Secure$/);
  assert.equal((await fetch(base + "/api/admin/session", {
    headers: { Cookie: logout.headers.getSetCookie()[0].split(";")[0] },
  })).status, 401);
});

test("transcription and runtime payload and validation limits still apply after routing", async (t) => {
  const directory = await fixtureDirectory(t);
  const secret = randomBytes(32).toString("hex");
  environment(t, { DIGIBUDDY_CONFIG_DIR: directory, DIGIBUDDY_RUNTIME_SHARED_SECRET: secret });
  const app = createApp();
  const principal = principalHeaders();
  assert.equal((await app.request("/api/transcribe", {
    method: "POST", headers: principal, body: "wrong type",
  })).status, 415);
  assert.equal((await app.request("/api/transcribe", {
    method: "POST", headers: { ...principal, "Content-Type": "audio/wav" }, body: "not WAV",
  })).status, 400);
  assert.equal((await app.request("/api/transcribe", {
    method: "POST",
    headers: { ...principal, "Content-Type": "audio/wav", "Content-Length": String(MAX_TRANSCRIPTION_BYTES + 1) },
  })).status, 413);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(MAX_TRANSCRIPTION_BYTES));
      controller.enqueue(new Uint8Array(1));
      controller.close();
    },
  });

  const request = new Request("http://fixture/api/transcribe", {
    method: "POST", headers: { ...principal, "Content-Type": "audio/wav" }, body, duplex: "half",
  } as RequestInit);
  assert.equal((await app.fetch(request)).status, 413);
  const runtimeHeaders = { "x-digibuddy-runtime-secret": secret };
  for (const path of ["/api/runtime/documents/catalogue.json",
    `/api/runtime/artifacts/${"a".repeat(32)}/${"b".repeat(32)}/file.txt`]) {
    assert.equal((await app.request(path, {
      method: "PUT", headers: { ...runtimeHeaders, "Content-Length": String(MAX_ARTIFACT_BYTES + 1) },
    })).status, 413);
  }
  assert.equal((await app.request("/api/runtime/documents/catalogue.json", {
    method: "PUT", headers: runtimeHeaders, body: "[]",
  })).status, 400);
});

test("WAV transcription keeps its authenticated multipart upstream contract over HTTP", async (t) => {
  environment(t, { GPT_TRANSCRIBE_ENDPOINT: "https://fixture.openai.azure.com" });
  const token = randomBytes(24).toString("hex");
  t.mock.method(ManagedIdentityCredential.prototype, "getToken", async (scope: string) => {
    assert.equal(scope, "https://cognitiveservices.azure.com/.default");
    return { token, expiresOnTimestamp: Date.now() + 60_000 };
  });
  const realFetch = globalThis.fetch;
  let upstreamCalls = 0;
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === "127.0.0.1") return realFetch(input, init);
    assert.equal(url.hostname, "fixture.openai.azure.com");
    assert.match(url.pathname, /\/audio\/transcriptions$/);
    assert.equal(init?.method, "POST");
    const authorization = new Headers(init?.headers).get("authorization");
    assert.deepEqual(authorization?.split(" "), ["Bearer", token]);
    assert.ok(init?.body instanceof FormData);
    const audio = init.body.get("file");
    assert.ok(audio instanceof File);
    assert.equal(audio.name, "recording.wav");
    assert.equal(audio.type, "audio/wav");
    assert.equal(audio.size, 44);
    upstreamCalls++;
    return Response.json({ text: " Transcript fixture " });
  });
  const base = await listen(t, createApp());
  const wav = new Uint8Array(44);
  wav.set(Buffer.from("RIFF"), 0);
  wav.set(Buffer.from("WAVE"), 8);
  const response = await fetch(base + "/api/transcribe", {
    method: "POST", headers: { ...principalHeaders(), "Content-Type": "audio/wav" }, body: wav,
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { text: "Transcript fixture" });
  assert.equal(upstreamCalls, 1);
});
