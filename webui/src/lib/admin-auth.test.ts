import assert from "node:assert/strict";
import { randomBytes, scryptSync } from "node:crypto";
import test from "node:test";

import {
  ADMIN_SESSION_COOKIE,
  AdminAuthError,
  createAdminSession,
  requireAdmin,
  verifyAdminCredentials,
} from "./admin-auth.ts";

function principalHeader(payload: unknown): Headers {
  return new Headers({
    "x-ms-client-principal": Buffer.from(JSON.stringify(payload)).toString("base64"),
  });
}

test("an anonymous caller is rejected", () => {
  assert.throws(
    () => requireAdmin(new Headers(), { ADMIN_PRINCIPAL_IDS: "abc" }),
    AdminAuthError,
  );
});

test("a signed-in caller outside the allowlist is rejected", () => {
  assert.throws(
    () =>
      requireAdmin(principalHeader({ userId: "other", userDetails: "o@example.com" }), {
        ADMIN_PRINCIPAL_IDS: "abc",
      }),
    AdminAuthError,
  );
});

test("an empty allowlist locks everyone out rather than letting everyone in", () => {
  assert.throws(
    () => requireAdmin(principalHeader({ userId: "abc" }), {}),
    AdminAuthError,
  );
});

test("an allowlisted object id is admitted", () => {
  const principal = requireAdmin(
    principalHeader({ userId: "ABC", userDetails: "admin@example.com" }),
    { ADMIN_PRINCIPAL_IDS: "abc, other" },
  );

  assert.equal(principal.name, "admin@example.com");
});

test("the object identifier claim is read when userId is absent", () => {
  const principal = requireAdmin(
    principalHeader({
      claims: [
        {
          typ: "http://schemas.microsoft.com/identity/claims/objectidentifier",
          val: "claim-id",
        },
        { typ: "preferred_username", val: "admin@example.com" },
      ],
    }),
    { ADMIN_PRINCIPAL_IDS: "claim-id" },
  );

  assert.equal(principal.id, "claim-id");
});

test("anonymous development access needs an explicit opt-in", () => {
  assert.throws(
    () => requireAdmin(new Headers(), { NODE_ENV: "development" }),
    AdminAuthError,
  );
  assert.equal(
    requireAdmin(new Headers(), {
      NODE_ENV: "development",
      ADMIN_ALLOW_ANONYMOUS: "true",
    }).id,
    "local",
  );
  assert.throws(
    () =>
      requireAdmin(new Headers(), {
        NODE_ENV: "production",
        ADMIN_ALLOW_ANONYMOUS: "true",
      }),
    AdminAuthError,
  );
});

test("a malformed principal header is not trusted", () => {
  assert.throws(
    () =>
      requireAdmin(new Headers({ "x-ms-client-principal": "not-base64-json" }), {
        ADMIN_PRINCIPAL_IDS: "abc",
      }),
    AdminAuthError,
  );
});

function passwordEnvironment() {
  const salt = randomBytes(16);
  const password = "correct horse battery staple";
  const hash = scryptSync(password, salt, 32, {
    N: 16384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  return {
    password,
    environment: {
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD_HASH: `scrypt$16384$8$1$${salt.toString("base64url")}$${hash.toString("base64url")}`,
      ADMIN_SESSION_SECRET: randomBytes(48).toString("base64url"),
      ADMIN_PRINCIPAL_IDS: "entra-admin",
    },
  };
}

test("configured password login takes precedence over Easy Auth", () => {
  const { environment } = passwordEnvironment();
  assert.throws(
    () =>
      requireAdmin(
        principalHeader({ userId: "entra-admin", userDetails: "admin@example.com" }),
        environment,
      ),
    AdminAuthError,
  );
});

test("password credentials create a signed administrator session", () => {
  const { password, environment } = passwordEnvironment();
  assert.equal(verifyAdminCredentials("admin", password, environment), true);
  assert.equal(verifyAdminCredentials("admin", "wrong", environment), false);
  assert.equal(verifyAdminCredentials("other", password, environment), false);

  const token = createAdminSession("admin", environment);
  const principal = requireAdmin(
    new Headers({ cookie: `${ADMIN_SESSION_COOKIE}=${token}` }),
    environment,
  );
  assert.equal(principal.id, "password:admin");
});

test("expired or modified password sessions are rejected", () => {
  const { environment } = passwordEnvironment();
  const expired = createAdminSession(
    "admin",
    environment,
    Date.now() - 9 * 60 * 60 * 1000,
  );
  assert.throws(
    () =>
      requireAdmin(
        new Headers({ cookie: `${ADMIN_SESSION_COOKIE}=${expired}` }),
        environment,
      ),
    AdminAuthError,
  );
  assert.throws(
    () =>
      requireAdmin(
        new Headers({ cookie: `${ADMIN_SESSION_COOKIE}=${expired}x` }),
        environment,
      ),
    AdminAuthError,
  );
});
