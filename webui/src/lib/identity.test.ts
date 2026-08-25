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

test("Entra tenant membership claims are decoded separately", () => {
  const principal = decodePrincipal(
    Buffer.from(
      JSON.stringify({
        identityProvider: "aad",
        userId: "member",
        claims: [
          { typ: "tid", val: "tenant-a" },
          { typ: "acct", val: "0" },
          { typ: "upn", val: "member@corp.example" },
        ],
      }),
    ).toString("base64"),
  );

  assert.equal(principal?.tenantId, "tenant-a");
  assert.equal(principal?.accountType, "0");
  assert.equal(principal?.upn, "member@corp.example");
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

const RESOURCE_TENANT = "16b3c013-d300-468d-ac64-7eda0820b6d3";
const CORPORATE_TENANT = "72f988bf-86f1-41af-91ab-2d7cd011db47";
const OTHER_TENANT = "99999999-9999-9999-9999-999999999999";

const corporateEnvironment = {
  NODE_ENV: "production",
  AUTH_REQUIRE_CORPORATE_ACCOUNT: "true",
  AUTH_TENANT_ID: RESOURCE_TENANT,
  AUTH_ALLOWED_UPN_DOMAINS: "corp.example,corp.example.net",
  AUTH_ALLOWED_EMAIL_DOMAINS: "microsoft.com",
  AUTH_ALLOWED_HOME_TENANT_IDS: CORPORATE_TENANT,
};

function corporateHeader({
  tenant = RESOURCE_TENANT,
  accountType = "0",
  upn = "member@corp.example",
  provider = "aad",
  identityProvider = "",
  email = "",
} = {}): Headers {
  return header({
    identityProvider: provider,
    userId: "member",
    claims: [
      { typ: "tid", val: tenant },
      { typ: "acct", val: accountType },
      { typ: "upn", val: upn },
      { typ: "idp", val: identityProvider },
      { typ: "preferred_username", val: email },
    ],
  });
}

test("a company tenant member is admitted", () => {
  assert.equal(
    requirePrincipal(corporateHeader(), corporateEnvironment).id,
    "member",
  );
});

test("the platform's provider label does not decide the outcome", () => {
  // Container Apps reports `bearer` where App Service reports `aad`. Treating
  // that label as proof of Entra locked out every employee of the tenant.
  assert.equal(
    requirePrincipal(
      corporateHeader({
        provider: "bearer",
        upn: "employee_microsoft.com#EXT#@corp.example",
        identityProvider: `https://sts.windows.net/${CORPORATE_TENANT}/`,
        email: "employee@microsoft.com",
      }),
      corporateEnvironment,
    ).id,
    "member",
  );
});

test("a trusted Microsoft corporate B2B account is admitted", () => {
  assert.equal(
    requirePrincipal(
      corporateHeader({
        accountType: "1",
        upn: "employee_microsoft.com#EXT#@corp.example",
        identityProvider: `https://sts.windows.net/${CORPORATE_TENANT}/`,
        email: "employee@microsoft.com",
      }),
      corporateEnvironment,
    ).id,
    "member",
  );
});

test("Easy Auth's generic ExternalAzureAD marker can use the trusted email", () => {
  assert.equal(
    requirePrincipal(
      corporateHeader({
        tenant: "",
        accountType: "0",
        upn: "",
        provider: "azureactivedirectory",
        identityProvider: "ExternalAzureAD",
        email: "employee@microsoft.com",
      }),
      corporateEnvironment,
    ).id,
    "member",
  );
});

test("untrusted external, personal, and wrong-tenant identities are rejected", () => {
  assert.throws(
    () =>
      requirePrincipal(
        corporateHeader({
          accountType: "1",
          upn: "person_hotmail.com#EXT#@corp.example",
          identityProvider: "live.com",
          email: "person@hotmail.com",
        }),
        corporateEnvironment,
      ),
    NotSignedInError,
  );
  // A personal account cannot buy its way in by presenting a company address.
  assert.throws(
    () =>
      requirePrincipal(
        corporateHeader({
          accountType: "1",
          upn: "",
          identityProvider: "live.com",
          email: "person@microsoft.com",
        }),
        corporateEnvironment,
      ),
    NotSignedInError,
  );
  assert.throws(
    () =>
      requirePrincipal(
        corporateHeader({
          accountType: "1",
          upn: "person_other.com#EXT#@corp.example",
          identityProvider: `https://sts.windows.net/${OTHER_TENANT}/`,
          email: "person@microsoft.com",
        }),
        corporateEnvironment,
      ),
    NotSignedInError,
  );
  assert.throws(
    () =>
      requirePrincipal(
        corporateHeader({ provider: "google" }),
        corporateEnvironment,
      ),
    NotSignedInError,
  );
  assert.throws(
    () =>
      requirePrincipal(
        corporateHeader({ tenant: OTHER_TENANT }),
        corporateEnvironment,
      ),
    NotSignedInError,
  );
});

test("an account outside every allowed domain is rejected", () => {
  assert.throws(
    () =>
      requirePrincipal(
        corporateHeader({
          upn: "contractor@partner.example",
          email: "contractor@partner.example",
        }),
        corporateEnvironment,
      ),
    NotSignedInError,
  );
});

const multiTenantEnvironment = {
  ...corporateEnvironment,
  // A non-production and a production tenant sharing one deployment.
  AUTH_TENANT_ID: `${RESOURCE_TENANT},${CORPORATE_TENANT}`,
};

test("a second trusted tenant signs in natively, without a B2B invitation", () => {
  // The production account is a member of its own tenant, so no `#EXT#` UPN and
  // no guest record exists in the tenant that owns the app registration.
  assert.equal(
    requirePrincipal(
      corporateHeader({
        tenant: CORPORATE_TENANT,
        provider: "bearer",
        upn: "employee@microsoft.com",
        identityProvider: "",
        email: "employee@microsoft.com",
      }),
      multiTenantEnvironment,
    ).id,
    "member",
  );
});

test("multi-tenant mode still refuses tenants that were not named", () => {
  assert.throws(
    () =>
      requirePrincipal(
        corporateHeader({
          tenant: OTHER_TENANT,
          provider: "bearer",
          upn: "employee@microsoft.com",
          email: "employee@microsoft.com",
        }),
        multiTenantEnvironment,
      ),
    NotSignedInError,
  );
  // A trusted tenant is not a licence for every domain it can mint.
  assert.throws(
    () =>
      requirePrincipal(
        corporateHeader({
          tenant: CORPORATE_TENANT,
          provider: "bearer",
          upn: "vendor@contoso.example",
          email: "vendor@contoso.example",
        }),
        multiTenantEnvironment,
      ),
    NotSignedInError,
  );
});

test("corporate mode fails closed when required claims are absent", () => {
  assert.throws(
    () =>
      requirePrincipal(
        header({ identityProvider: "aad", userId: "member" }),
        corporateEnvironment,
      ),
    NotSignedInError,
  );
});
