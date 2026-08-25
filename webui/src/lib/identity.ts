/**
 * Who is using the console.
 *
 * Sign-in is App Service Easy Auth, which injects `x-ms-client-principal`. That
 * header is the only thing trusted: a request never names its own user.
 *
 * Two things are derived from it, and they are deliberately different:
 *
 * * `principal` — the readable identity, for display and for the administrator
 *   allowlist.
 * * `ownerKey` — a stable, opaque hash used to partition storage. It keeps an
 *   email address out of blob paths and log lines, while still giving each
 *   person their own namespace.
 *
 * Providers matter here. The same human signing in with Microsoft, Google and
 * GitHub is three different principals, so three different owner keys. That is
 * the honest behaviour: the console cannot know they are the same person, and
 * pretending otherwise would let one provider's account reach another's files.
 */

import { createHash } from "node:crypto";

type Environment = Record<string, string | undefined>;

export type Principal = {
  /** Provider-issued subject. Stable for a given account and provider. */
  id: string;
  /** What the person is called, for display only. */
  name: string;
  /** `aad`, `google`, `github`, … as reported by Easy Auth. */
  provider: string;
  /** Entra tenant that issued the identity, when available. */
  tenantId?: string;
  /** Entra optional `acct` claim: `0` member, `1` guest. */
  accountType?: string;
  /** Directory UPN, kept separate from the display name used by the UI. */
  upn?: string;
  /** Home tenant or identity provider represented by Entra's `idp` claim. */
  identityProvider?: string;
  /** Trusted sign-in address when Entra emits one. */
  email?: string;
};

export class NotSignedInError extends Error {}

function text(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function claim(claims: unknown, ...types: string[]): string {
  if (!Array.isArray(claims)) return "";
  for (const type of types) {
    for (const entry of claims) {
      if (!entry || typeof entry !== "object") continue;
      const item = entry as Record<string, unknown>;
      if (text(item.typ) === type) return text(item.val);
    }
  }
  return "";
}

/** Decode the Easy Auth principal header. Returns null when it is unusable. */
export function decodePrincipal(header: string): Principal | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(header, "base64").toString("utf-8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const raw = parsed as Record<string, unknown>;
  const claims = raw.claims;

  const id =
    text(raw.userId) ||
    claim(
      claims,
      "http://schemas.microsoft.com/identity/claims/objectidentifier",
      "oid",
      "sub",
      "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier",
    );
  const name =
    text(raw.userDetails) ||
    claim(claims, "preferred_username", "email", "name");
  const provider = text(raw.identityProvider) || text(raw.auth_typ);
  const tenantId = claim(
    claims,
    "tid",
    "http://schemas.microsoft.com/identity/claims/tenantid",
  );
  const accountType = claim(claims, "acct");
  const upn = claim(
    claims,
    "upn",
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn",
  );
  const identityProvider = claim(
    claims,
    "idp",
    "http://schemas.microsoft.com/identity/claims/identityprovider",
  );
  const claimedEmail = claim(claims, "preferred_username", "email");
  const mappedEmail = claim(
    claims,
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
  );
  const email =
    claimedEmail ||
    mappedEmail ||
    (name.includes("@") && !name.includes("#EXT#") ? name : "");

  return id || name
    ? {
        id,
        name: name || id,
        provider,
        ...(tenantId ? { tenantId } : {}),
        ...(accountType ? { accountType } : {}),
        ...(upn ? { upn } : {}),
        ...(identityProvider ? { identityProvider } : {}),
        ...(email ? { email } : {}),
      }
    : null;
}

function allowedUpnDomains(environment: Environment): string[] {
  return text(environment.AUTH_ALLOWED_UPN_DOMAINS)
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function commaSeparated(environment: Environment, name: string): string[] {
  return text(environment[name])
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function domainOf(value: string): string {
  const separator = value.lastIndexOf("@");
  return separator === -1 ? "" : value.slice(separator + 1).toLowerCase();
}

function tenantFromIdentityProvider(value: string): string {
  const normalised = value.trim().toLowerCase();
  const match = /\/([0-9a-f-]{36})\/?$/.exec(normalised);
  return match?.[1] ?? (/^[0-9a-f-]{36}$/.test(normalised) ? normalised : "");
}

/**
 * Providers that are not the deployment's Entra tenant.
 *
 * The Easy Auth `identityProvider`/`auth_typ` value is platform-dependent —
 * Container Apps reports `bearer`, App Service reports `aad` — so it cannot be
 * used to confirm that a caller came from Entra. It is reliable in the other
 * direction: these values only appear for a social or personal account, and
 * `live.com` is exactly the personal Microsoft account this policy excludes.
 */
const NON_CORPORATE_PROVIDERS = new Set([
  "google",
  "github",
  "facebook",
  "twitter",
  "apple",
  "live.com",
  "windowslive",
  "msa",
]);

/** Sign-in addresses this account can be held to, most authoritative first. */
function corporateAddresses(principal: Principal): string[] {
  return [text(principal.email), text(principal.upn), text(principal.name)]
    .map((value) => value.toLowerCase())
    .filter((value) => value.includes("@") && !value.includes("#ext#"));
}

/**
 * Confirm the caller is a company account.
 *
 * The decision rests on what Entra actually vouches for: the tenant that issued
 * the token, the identity provider behind it, and the verified sign-in address.
 * It deliberately does *not* rest on the Easy Auth provider label, which is
 * `bearer` on Container Apps and `aad` on App Service — reading it as proof of
 * Entra locked every valid employee out of the deployment.
 *
 * With a multi-tenant app registration any Entra work tenant can reach the
 * front door, so this allowlist is the boundary that keeps the deployment to
 * the organizations it names.
 */
function requireCorporateAccount(
  principal: Principal,
  environment: Environment,
): void {
  if (environment.AUTH_REQUIRE_CORPORATE_ACCOUNT !== "true") return;

  // Accepts one tenant or a comma-separated set, so a non-production and a
  // production tenant can share one deployment.
  const allowedTenants = commaSeparated(environment, "AUTH_TENANT_ID");
  const nativeDomains = allowedUpnDomains(environment);
  const corporateDomains = commaSeparated(
    environment,
    "AUTH_ALLOWED_EMAIL_DOMAINS",
  );
  const allowedDomains = [...new Set([...nativeDomains, ...corporateDomains])];
  const homeTenants = commaSeparated(environment, "AUTH_ALLOWED_HOME_TENANT_IDS");
  const trustedTenants = [...new Set([...allowedTenants, ...homeTenants])];

  const identityProvider = text(principal.identityProvider).toLowerCase();
  const sourceTenant = tenantFromIdentityProvider(identityProvider);
  const addresses = corporateAddresses(principal);
  const domains = addresses.map(domainOf);

  // A personal or social account is refused whatever address it presents, so a
  // Hotmail guest cannot reach the console by carrying a company-looking name.
  const personalAccount =
    NON_CORPORATE_PROVIDERS.has(principal.provider.toLowerCase()) ||
    NON_CORPORATE_PROVIDERS.has(identityProvider) ||
    (Boolean(identityProvider) &&
      !sourceTenant &&
      identityProvider !== "externalazuread");
  // Absent means the platform did not project the claim, which is normal for
  // Easy Auth; a present value has to name one of the trusted tenants.
  const tenantIsTrusted =
    !principal.tenantId ||
    trustedTenants.includes(principal.tenantId.toLowerCase());
  const sourceIsTrusted = !sourceTenant || trustedTenants.includes(sourceTenant);

  const valid =
    !personalAccount &&
    allowedTenants.length > 0 &&
    tenantIsTrusted &&
    sourceIsTrusted &&
    allowedDomains.length > 0 &&
    domains.some((domain) => allowedDomains.includes(domain));

  if (!valid) {
    console.warn(
      [
        "corporate authentication rejected",
        `provider=${principal.provider || "missing"}`,
        `identityProvider=${identityProvider || "missing"}`,
        `tenantTrusted=${tenantIsTrusted}`,
        `sourceTrusted=${sourceIsTrusted}`,
        `personalAccount=${personalAccount}`,
        `domains=${domains.join("|") || "missing"}`,
      ].join(" "),
    );
    throw new NotSignedInError(
      "Use a Microsoft work account issued by this organization.",
    );
  }
}

/**
 * The signed-in user, or a thrown error.
 *
 * Throwing rather than returning null keeps a caller from forgetting to check.
 */
export function requirePrincipal(
  headers: Headers,
  environment: Environment = process.env,
): Principal {
  const header = headers.get("x-ms-client-principal");
  const principal = header ? decodePrincipal(header) : null;
  if (principal) {
    requireCorporateAccount(principal, environment);
    return principal;
  }

  // Local development has no Easy Auth in front of it. The opt-in is explicit
  // and refused in production, so the convenience cannot reach a deployment.
  if (
    environment.NODE_ENV !== "production" &&
    environment.ADMIN_ALLOW_ANONYMOUS === "true"
  ) {
    return { id: "local", name: "local developer", provider: "local" };
  }
  throw new NotSignedInError("Sign in to use this agent.");
}

/** The signed-in user, or null when nobody is signed in. */
export function optionalPrincipal(
  headers: Headers,
  environment: Environment = process.env,
): Principal | null {
  try {
    return requirePrincipal(headers, environment);
  } catch {
    return null;
  }
}

/**
 * The storage namespace for a principal.
 *
 * A hash, so a blob path never carries an email address, and 32 hex characters
 * so it matches the shape the artifact path validator already enforces for ids.
 * Salted with the provider because the same subject value from two providers is
 * two different accounts.
 */
export function ownerKey(principal: Principal): string {
  const subject = `${principal.provider}\u0000${principal.id || principal.name}`;
  return createHash("sha256").update(subject).digest("hex").slice(0, 32);
}
