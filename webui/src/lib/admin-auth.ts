/**
 * Administrator authorisation.
 *
 * A deployment may require a dedicated username/password session for `/admin`.
 * Passwords are stored only as scrypt hashes and successful login produces a
 * short-lived, HMAC-signed HttpOnly cookie. Deployments without those settings
 * retain the existing Easy Auth principal allowlist.
 */

import {
  createHash,
  createHmac,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

type Environment = Record<string, string | undefined>;

export type AdminPrincipal = { id: string; name: string };

export class AdminAuthError extends Error {}

export const ADMIN_SESSION_COOKIE = "digibuddy-admin";
export const ADMIN_SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function allowlist(environment: Environment): string[] {
  return stringValue(environment.ADMIN_PRINCIPAL_IDS)
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function decodePrincipal(header: string): AdminPrincipal | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(header, "base64").toString("utf-8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const principal = parsed as Record<string, unknown>;
  const claims = Array.isArray(principal.claims) ? principal.claims : [];
  const claim = (type: string): string => {
    for (const entry of claims) {
      if (!entry || typeof entry !== "object") continue;
      const item = entry as Record<string, unknown>;
      if (stringValue(item.typ) === type) return stringValue(item.val);
    }
    return "";
  };

  const id =
    stringValue(principal.userId) ||
    claim("http://schemas.microsoft.com/identity/claims/objectidentifier") ||
    claim("oid");
  const name =
    stringValue(principal.userDetails) ||
    claim("preferred_username") ||
    claim("name");
  return id || name ? { id, name: name || id } : null;
}

function passwordAuthConfigured(environment: Environment): boolean {
  return Boolean(
    stringValue(environment.ADMIN_USERNAME) &&
      stringValue(environment.ADMIN_PASSWORD_HASH) &&
      stringValue(environment.ADMIN_SESSION_SECRET),
  );
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function sameText(left: string, right: string): boolean {
  return timingSafeEqual(digest(left), digest(right));
}

type PasswordHash = {
  cost: number;
  blockSize: number;
  parallelization: number;
  salt: Buffer;
  expected: Buffer;
};

function parsePasswordHash(value: string): PasswordHash | null {
  const [algorithm, cost, blockSize, parallelization, salt, expected] =
    value.split("$");
  if (algorithm !== "scrypt") return null;
  const parsed = {
    cost: Number(cost),
    blockSize: Number(blockSize),
    parallelization: Number(parallelization),
    salt: Buffer.from(salt || "", "base64url"),
    expected: Buffer.from(expected || "", "base64url"),
  };
  if (
    !Number.isSafeInteger(parsed.cost) ||
    parsed.cost < 2 ||
    (parsed.cost & (parsed.cost - 1)) !== 0 ||
    !Number.isSafeInteger(parsed.blockSize) ||
    parsed.blockSize < 1 ||
    !Number.isSafeInteger(parsed.parallelization) ||
    parsed.parallelization < 1 ||
    parsed.salt.length < 16 ||
    parsed.expected.length < 32
  ) {
    return null;
  }
  return parsed;
}

/** Verify credentials without disclosing which field was incorrect. */
export function verifyAdminCredentials(
  username: string,
  password: string,
  environment: Environment = process.env,
): boolean {
  const expectedUsername = stringValue(environment.ADMIN_USERNAME);
  const parsed = parsePasswordHash(stringValue(environment.ADMIN_PASSWORD_HASH));
  if (!expectedUsername || !parsed || password.length > 1024) return false;

  let actual: Buffer;
  try {
    actual = scryptSync(password, parsed.salt, parsed.expected.length, {
      N: parsed.cost,
      r: parsed.blockSize,
      p: parsed.parallelization,
      maxmem: 64 * 1024 * 1024,
    });
  } catch {
    return false;
  }
  return (
    sameText(username.trim(), expectedUsername) &&
    timingSafeEqual(actual, parsed.expected)
  );
}

function sessionSignature(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/** Create the value stored in the administrator's HttpOnly session cookie. */
export function createAdminSession(
  username: string,
  environment: Environment = process.env,
  now = Date.now(),
): string {
  const secret = stringValue(environment.ADMIN_SESSION_SECRET);
  const expectedUsername = stringValue(environment.ADMIN_USERNAME);
  if (secret.length < 32 || !sameText(username.trim(), expectedUsername)) {
    throw new AdminAuthError("Administrator password login is not configured.");
  }
  const payload = Buffer.from(
    JSON.stringify({
      version: 1,
      username: expectedUsername,
      expires: now + ADMIN_SESSION_MAX_AGE_SECONDS * 1000,
    }),
  ).toString("base64url");
  return `${payload}.${sessionSignature(payload, secret)}`;
}

function cookieValue(headers: Headers, name: string): string {
  const cookie = headers.get("cookie") ?? "";
  for (const part of cookie.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }
  return "";
}

function passwordPrincipal(
  headers: Headers,
  environment: Environment,
  now = Date.now(),
): AdminPrincipal | null {
  const token = cookieValue(headers, ADMIN_SESSION_COOKIE);
  const separator = token.lastIndexOf(".");
  const secret = stringValue(environment.ADMIN_SESSION_SECRET);
  if (separator < 1 || secret.length < 32) return null;
  const payload = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  if (!sameText(signature, sessionSignature(payload, secret))) return null;

  let session: unknown;
  try {
    session = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8"));
  } catch {
    return null;
  }
  if (!session || typeof session !== "object") return null;
  const value = session as Record<string, unknown>;
  const username = stringValue(value.username);
  const expires = typeof value.expires === "number" ? value.expires : 0;
  if (
    value.version !== 1 ||
    !sameText(username, stringValue(environment.ADMIN_USERNAME)) ||
    expires <= now ||
    expires > now + ADMIN_SESSION_MAX_AGE_SECONDS * 1000
  ) {
    return null;
  }
  return { id: `password:${username}`, name: username };
}

/**
 * Resolve the caller and confirm they may administer the runtime. Throws rather
 * than returning null so a caller cannot forget to check the result.
 */
export function requireAdmin(
  headers: Headers,
  environment: Environment = process.env,
): AdminPrincipal {
  if (passwordAuthConfigured(environment)) {
    const principal = passwordPrincipal(headers, environment);
    if (principal) return principal;
    throw new AdminAuthError("Administrator sign-in required.");
  }

  const allowed = allowlist(environment);
  const header = headers.get("x-ms-client-principal");
  const principal = header ? decodePrincipal(header) : null;

  if (!principal) {
    // Local development has no Easy Auth in front of it. Requiring an explicit
    // opt-in keeps that convenience from ever reaching a deployment.
    if (
      environment.NODE_ENV !== "production" &&
      environment.ADMIN_ALLOW_ANONYMOUS === "true"
    ) {
      return { id: "local", name: "local developer" };
    }
    throw new AdminAuthError("Sign in to administer the runtime.");
  }

  if (allowed.length === 0) {
    throw new AdminAuthError(
      "No administrators are configured. Set ADMIN_PRINCIPAL_IDS.",
    );
  }
  const identifiers = [principal.id, principal.name]
    .filter(Boolean)
    .map((value) => value.toLowerCase());
  if (!identifiers.some((value) => allowed.includes(value))) {
    throw new AdminAuthError("You are not an administrator of this runtime.");
  }
  return principal;
}
