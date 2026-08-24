import assert from "node:assert/strict";
import test from "node:test";

import {
  NotSignedInError,
  decodePrincipal,
  optionalPrincipal,
  ownerKey,
  requirePrincipal,
} from "./identity.ts";

function header(payload: Record<string, unknown>): Headers {
  return new Headers({
    "x-ms-client-principal": Buffer.from(JSON.stringify(payload)).toString("base64"),
  });
}

test("a Microsoft principal is read from the Easy Auth header", () => {
  const principal = decodePrincipal(
    Buffer.from(
      JSON.stringify({
        identityProvider: "aad",
        userId: "4c28958d-0a01-4c36-9647-f2566b528c0a",
        userDetails: "admin@example.com",
      }),
    ).toString("base64"),
  );

  assert.equal(principal?.provider, "aad");
  assert.equal(principal?.id, "4c28958d-0a01-4c36-9647-f2566b528c0a");
  assert.equal(principal?.name, "admin@example.com");
});

test("Google and GitHub principals are read from their claims", () => {
  const google = decodePrincipal(
    Buffer.from(
      JSON.stringify({
        identityProvider: "google",
        claims: [
          { typ: "sub", val: "104729183746512" },
          { typ: "email", val: "person@gmail.com" },
        ],
      }),
    ).toString("base64"),
  );
  const github = decodePrincipal(
    Buffer.from(
      JSON.stringify({
        identityProvider: "github",
        claims: [
          {
            typ: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier",
            val: "9876543",
          },
          { typ: "name", val: "octocat" },
        ],
      }),
    ).toString("base64"),
  );

  assert.equal(google?.id, "104729183746512");
  assert.equal(google?.name, "person@gmail.com");
  assert.equal(github?.id, "9876543");
  assert.equal(github?.name, "octocat");
});

test("an unusable header is not a principal", () => {
  assert.equal(decodePrincipal("not base64 at all!!"), null);
  assert.equal(decodePrincipal(Buffer.from("[]").toString("base64")), null);
  assert.equal(decodePrincipal(Buffer.from("{}").toString("base64")), null);
});

test("no header means not signed in", () => {
  assert.throws(
    () => requirePrincipal(new Headers(), { NODE_ENV: "production" }),
    NotSignedInError,
  );
  assert.equal(optionalPrincipal(new Headers(), { NODE_ENV: "production" }), null);
});

test("the anonymous escape hatch cannot reach production", () => {
  const environment = { ADMIN_ALLOW_ANONYMOUS: "true", NODE_ENV: "production" };

  assert.throws(() => requirePrincipal(new Headers(), environment), NotSignedInError);
  assert.equal(
    requirePrincipal(new Headers(), { ...environment, NODE_ENV: "development" }).id,
    "local",
  );
});

test("each account gets its own storage namespace", () => {
  const microsoft = ownerKey({ id: "abc", name: "a@x.com", provider: "aad" });
  const google = ownerKey({ id: "abc", name: "a@x.com", provider: "google" });

  // Same subject value from two providers is two different accounts, and the
  // console has no way to know they are the same human. Merging them would let
  // one provider's account reach another's files.
  assert.notEqual(microsoft, google);
  assert.match(microsoft, /^[0-9a-f]{32}$/);
  assert.equal(microsoft, ownerKey({ id: "abc", name: "changed", provider: "aad" }));
});

test("a namespace never carries the identity it came from", () => {
  const key = ownerKey({ id: "someone@contoso.com", name: "Someone", provider: "aad" });

  assert.equal(key.includes("someone"), false);
  assert.equal(key.includes("contoso"), false);
});

test("the header, not the request, decides who the caller is", () => {
  // A caller cannot promote itself by claiming an identity in the body or in
  // some other header; only x-ms-client-principal is read.
  const spoofed = new Headers({ "x-user-id": "admin", "x-ms-client-principal-id": "admin" });

  assert.throws(() => requirePrincipal(spoofed, { NODE_ENV: "production" }), NotSignedInError);
  assert.equal(
    requirePrincipal(header({ identityProvider: "aad", userId: "real" }), {
      NODE_ENV: "production",
    }).id,
    "real",
  );
});
