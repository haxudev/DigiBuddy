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
};

export class NotSignedInError extends Error {}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
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

  return id || name ? { id, name: name || id, provider } : null;
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
  if (principal) return principal;

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
