import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { ConfigValidationError } from "./admin-config.ts";
import {
  PayloadTooLargeError,
  RUNTIME_AUDIENCE_ENV,
  RUNTIME_PRINCIPAL_IDS_ENV,
  RUNTIME_SHARED_SECRET_ENV,
  RUNTIME_SHARED_SECRET_HEADER,
  RuntimeAuthError,
  readBoundedBody,
  requireRuntimePrincipal,
  runtimeArtifactPath,
  runtimeBundlePath,
  runtimeWritableDocument,
} from "./runtime-auth.ts";

const TENANT = "72f988bf-86f1-41af-91ab-2d7cd011db47";
const OID = "11111111-2222-3333-4444-555555555555";
const NOW = 1_800_000_000_000;
const SHARED_SECRET = "s".repeat(32);
const VERIFY = async () => undefined;

function token(claims: Record<string, unknown>): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", kid: "kid" }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: `https://login.microsoftonline.com/${TENANT}/v2.0`,
      aud: "api://digibuddy",
      tid: TENANT,
      oid: OID,
      exp: Math.floor(NOW / 1000) + 3600,
      ...claims,
    }),
  ).toString("base64url");
  return `${header}.${payload}.signature`;
}

function headers(value: string): Headers {
  return new Headers({ authorization: `Bearer ${value}` });
}

function environment(overrides: Record<string, string | undefined> = {}) {
  return {
    AUTH_TENANT_ID: TENANT,
    [RUNTIME_AUDIENCE_ENV]: "api://digibuddy/.default",
    [RUNTIME_PRINCIPAL_IDS_ENV]: OID,
    ...overrides,
  };
}

test("runtime auth rejects a missing bearer token", async () => {
  await assert.rejects(
    () =>
      requireRuntimePrincipal(new Headers(), environment(), {
        now: () => NOW,
        verifyToken: VERIFY,
      }),
    RuntimeAuthError,
  );
});

test("runtime auth rejects a malformed bearer token", async () => {
  await assert.rejects(
    () =>
      requireRuntimePrincipal(headers("not-a-jwt"), environment(), {
        now: () => NOW,
        verifyToken: VERIFY,
      }),
    RuntimeAuthError,
  );
});

test("runtime auth rejects a principal outside the allowlist", async () => {
  await assert.rejects(
    () =>
      requireRuntimePrincipal(headers(token({ oid: "other" })), environment(), {
        now: () => NOW,
        verifyToken: VERIFY,
      }),
    RuntimeAuthError,
  );
});

test("runtime auth denies everyone when no runtime auth is configured", async () => {
  await assert.rejects(
    () =>
      requireRuntimePrincipal(
        headers(token({})),
        environment({
          [RUNTIME_PRINCIPAL_IDS_ENV]: undefined,
          [RUNTIME_SHARED_SECRET_ENV]: undefined,
        }),
        {
          now: () => NOW,
          verifyToken: VERIFY,
        },
      ),
    RuntimeAuthError,
  );
});

test("runtime auth admits a matching shared secret", async (t) => {
  const timing = t.mock.method(
    crypto,
    "timingSafeEqual",
    crypto.timingSafeEqual,
  );
  const principal = await requireRuntimePrincipal(
    headers(SHARED_SECRET),
    environment({
      [RUNTIME_PRINCIPAL_IDS_ENV]: "",
      [RUNTIME_SHARED_SECRET_ENV]: SHARED_SECRET,
    }),
    {
      now: () => NOW,
      verifyToken: () => {
        throw new Error("JWT path should not run for a shared secret.");
      },
    },
  );

  assert.deepEqual(principal, { oid: "shared-secret", tenantId: "" });
  assert.equal(timing.mock.callCount(), 1);
});

test("runtime auth admits a shared secret from the runtime header", async () => {
  const principal = await requireRuntimePrincipal(
    new Headers({ [RUNTIME_SHARED_SECRET_HEADER]: SHARED_SECRET }),
    environment({
      [RUNTIME_PRINCIPAL_IDS_ENV]: "",
      [RUNTIME_SHARED_SECRET_ENV]: SHARED_SECRET,
    }),
    {
      now: () => NOW,
      verifyToken: () => {
        throw new Error("JWT path should not run for a shared secret.");
      },
    },
  );

  assert.deepEqual(principal, { oid: "shared-secret", tenantId: "" });
});

test("runtime auth refuses a wrong shared secret of the same length", async () => {
  await assert.rejects(
    () =>
      requireRuntimePrincipal(
        headers("x".repeat(SHARED_SECRET.length)),
        environment({ [RUNTIME_SHARED_SECRET_ENV]: SHARED_SECRET }),
        {
          now: () => NOW,
          verifyToken: VERIFY,
        },
      ),
    RuntimeAuthError,
  );
});

test("runtime auth refuses a wrong shared secret of a different length", async (t) => {
  const timing = t.mock.method(
    crypto,
    "timingSafeEqual",
    crypto.timingSafeEqual,
  );

  await assert.rejects(
    () =>
      requireRuntimePrincipal(
        headers("wrong"),
        environment({ [RUNTIME_SHARED_SECRET_ENV]: SHARED_SECRET }),
        {
          now: () => NOW,
          verifyToken: VERIFY,
        },
      ),
    RuntimeAuthError,
  );
  assert.equal(timing.mock.callCount(), 1);
});

test("runtime auth refuses a configured shared secret shorter than 32 characters", async () => {
  const weakSecret = "w".repeat(31);

  await assert.rejects(
    () =>
      requireRuntimePrincipal(
        headers(weakSecret),
        environment({
          [RUNTIME_PRINCIPAL_IDS_ENV]: "",
          [RUNTIME_SHARED_SECRET_ENV]: weakSecret,
        }),
        {
          now: () => NOW,
          verifyToken: VERIFY,
        },
      ),
    (error: unknown) =>
      error instanceof RuntimeAuthError &&
      error.message.includes(`${RUNTIME_SHARED_SECRET_ENV} must be at least 32`),
  );
});

test("runtime auth keeps the Entra path when no shared secret is configured", async () => {
  let verifyCalls = 0;

  const principal = await requireRuntimePrincipal(
    headers(token({})),
    environment({ [RUNTIME_SHARED_SECRET_ENV]: undefined }),
    {
      now: () => NOW,
      verifyToken: () => {
        verifyCalls += 1;
      },
    },
  );

  assert.deepEqual(principal, { oid: OID, tenantId: TENANT });
  assert.equal(verifyCalls, 1);
});

test("runtime auth admits an allowed principal", async () => {
  const principal = await requireRuntimePrincipal(
    headers(token({ oid: OID.toUpperCase() })),
    environment(),
    {
      now: () => NOW,
      verifyToken: VERIFY,
    },
  );

  assert.deepEqual(principal, { oid: OID, tenantId: TENANT });
});

test("only catalogue.json is writable through the runtime API", () => {
  assert.equal(runtimeWritableDocument("catalogue.json"), "catalogue.json");
  assert.throws(
    () => runtimeWritableDocument("models.json"),
    ConfigValidationError,
  );
});

test("bundle paths must stay content-addressed and traversal-free", () => {
  const digest = "a".repeat(64);
  assert.equal(
    runtimeBundlePath("release_notes", `${digest}.zip`),
    `bundles/release_notes/${digest}.zip`,
  );
  assert.throws(
    () => runtimeBundlePath("../escape", `${digest}.zip`),
    ConfigValidationError,
  );
  assert.throws(
    () => runtimeBundlePath("release_notes", `../${digest}.zip`),
    ConfigValidationError,
  );
});

test("artifact paths are validated before storage access", () => {
  const owner = "b".repeat(32);
  const artifact = "a".repeat(32);

  assert.equal(
    runtimeArtifactPath(owner, artifact, "报告.md"),
    `artifacts/${owner}/${artifact}/报告.md`,
  );
  assert.throws(
    () => runtimeArtifactPath(owner, artifact, "../models.json"),
    ConfigValidationError,
  );
  assert.throws(
    () => runtimeArtifactPath("../owner", artifact, "report.md"),
    ConfigValidationError,
  );
});

test("bounded body reads reject oversized requests", async () => {
  const request = new Request("https://console.example/api/runtime/documents/catalogue.json", {
    body: "012345",
    method: "PUT",
  });

  await assert.rejects(() => readBoundedBody(request, 4), PayloadTooLargeError);
});
