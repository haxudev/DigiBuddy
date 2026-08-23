import assert from "node:assert/strict";
import test from "node:test";

import { AdminAuthError, requireAdmin } from "./admin-auth.ts";

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
