import crypto from "node:crypto";

import {
  CATALOGUE_DOCUMENT,
  ConfigValidationError,
  artifactStoragePath,
  assertDocumentName,
  type DocumentName,
} from "./admin-config.ts";
import { MAX_ARTIFACT_BYTES } from "./artifacts.ts";

type Environment = Record<string, string | undefined>;

export const RUNTIME_PRINCIPAL_IDS_ENV = "DIGIBUDDY_RUNTIME_PRINCIPAL_IDS";
export const RUNTIME_AUDIENCE_ENV = "DIGIBUDDY_CONFIG_API_SCOPE";
export const RUNTIME_SHARED_SECRET_ENV = "DIGIBUDDY_RUNTIME_SHARED_SECRET";

const CLOCK_SKEW_SECONDS = 60;
const JWKS_TIMEOUT_MS = 2000;
const MIN_RUNTIME_SHARED_SECRET_LENGTH = 32;
const BUNDLE_NAME = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
const BUNDLE_SHA = /^[0-9a-f]{64}$/;

export type RuntimePrincipal = { oid: string; tenantId: string };

type RuntimeClaims = {
  iss?: unknown;
  aud?: unknown;
  oid?: unknown;
  tid?: unknown;
  exp?: unknown;
  nbf?: unknown;
};

type JwtHeader = {
  alg?: unknown;
  kid?: unknown;
  x5t?: unknown;
};

type Jwk = {
  kid?: string;
  x5t?: string;
  kty?: string;
  n?: string;
  e?: string;
  alg?: string;
  use?: string;
};

type JwksCacheEntry = { expires: number; keys: Jwk[] };

type RuntimeAuthOptions = {
  now?: () => number;
  verifyToken?: (
    token: string,
    claims: RuntimeClaims,
    environment: Environment,
  ) => Promise<void> | void;
};

const jwksCache = new Map<string, JwksCacheEntry>();

export class RuntimeAuthError extends Error {
  readonly status: number;

  constructor(message: string, status = 401) {
    super(message);
    this.status = status;
  }
}

export class PayloadTooLargeError extends Error {}

/**
 * Record a refused runtime call.
 *
 * This endpoint is the runtime's only way to reach the store, so a refusal is
 * an operational event, not noise: without it a misconfigured audience or an
 * unassigned principal is indistinguishable from an agent that never called
 * at all. The reason is safe to log; the token is never touched.
 */
export function logRuntimeRefusal(route: string, error: RuntimeAuthError): void {
  console.warn(
    `runtime request refused route=${route} status=${error.status} reason=${error.message}`,
  );
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function commaList(value: unknown): string[] {
  return text(value)
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function bearer(headers: Headers): string {
  const header = headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) throw new RuntimeAuthError("Bearer token required.");
  return match[1].trim();
}

function jsonPart<T>(value: string): T {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf-8")) as T;
  } catch {
    throw new RuntimeAuthError("Malformed bearer token.");
  }
}

function decodeJwt(token: string): { header: JwtHeader; claims: RuntimeClaims } {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => !part)) {
    throw new RuntimeAuthError("Malformed bearer token.");
  }
  return {
    header: jsonPart<JwtHeader>(parts[0]),
    claims: jsonPart<RuntimeClaims>(parts[1]),
  };
}

function sharedSecretMatches(presented: string, configured: string): boolean {
  const presentedBuffer = Buffer.from(presented, "utf-8");
  const configuredBuffer = Buffer.from(configured, "utf-8");
  const sameLength = presentedBuffer.byteLength === configuredBuffer.byteLength;
  const comparablePresented = Buffer.alloc(configuredBuffer.byteLength);
  presentedBuffer.copy(
    comparablePresented,
    0,
    0,
    Math.min(presentedBuffer.byteLength, configuredBuffer.byteLength),
  );
  const matches = crypto.timingSafeEqual(configuredBuffer, comparablePresented);
  return matches && sameLength;
}

function principalFromSharedSecret(
  token: string,
  environment: Environment,
): RuntimePrincipal | null {
  const configured = text(environment[RUNTIME_SHARED_SECRET_ENV]);
  if (!configured) return null;

  const matches = sharedSecretMatches(token, configured);
  if (configured.length < MIN_RUNTIME_SHARED_SECRET_LENGTH) {
    if (matches) {
      throw new RuntimeAuthError(
        `${RUNTIME_SHARED_SECRET_ENV} must be at least 32 characters.`,
        403,
      );
    }
    return null;
  }

  return matches ? { oid: "shared-secret", tenantId: "" } : null;
}

function issuerTenant(issuer: string): string {
  const lower = issuer.toLowerCase();
  const v1 = /^https:\/\/sts\.windows\.net\/([0-9a-f-]{36})\/$/.exec(lower);
  if (v1) return v1[1];
  const v2 =
    /^https:\/\/login\.microsoftonline\.com\/([0-9a-f-]{36})\/v2\.0$/.exec(
      lower,
    );
  return v2?.[1] ?? "";
}

function validateIssuer(
  claims: RuntimeClaims,
  environment: Environment,
): string {
  const allowedTenants = commaList(environment.AUTH_TENANT_ID);
  if (allowedTenants.length === 0) {
    throw new RuntimeAuthError("Runtime token issuer is not configured.", 403);
  }

  const issuer = text(claims.iss);
  const tenant = issuerTenant(issuer);
  const tokenTenant = text(claims.tid).toLowerCase();
  if (
    !tenant ||
    !allowedTenants.includes(tenant) ||
    (tokenTenant && tokenTenant !== tenant)
  ) {
    throw new RuntimeAuthError("Runtime token issuer is not trusted.", 403);
  }
  return tenant;
}

function expectedAudiences(environment: Environment): string[] {
  const values = commaList(environment[RUNTIME_AUDIENCE_ENV]);
  const audiences = new Set<string>();
  for (const value of values) {
    audiences.add(value);
    if (value.endsWith("/.default")) {
      audiences.add(value.slice(0, -"/.default".length));
    }
  }
  return [...audiences];
}

function validateAudience(
  claims: RuntimeClaims,
  environment: Environment,
): void {
  const expected = expectedAudiences(environment);
  if (expected.length === 0) {
    throw new RuntimeAuthError("Runtime token audience is not configured.", 403);
  }
  const actual = Array.isArray(claims.aud)
    ? claims.aud.map(text).map((value) => value.toLowerCase())
    : [text(claims.aud).toLowerCase()];
  if (!actual.some((value) => expected.includes(value))) {
    throw new RuntimeAuthError("Runtime token audience is not trusted.", 403);
  }
}

function validateLifetime(claims: RuntimeClaims, now: number): void {
  const exp = typeof claims.exp === "number" ? claims.exp : 0;
  const nbf = typeof claims.nbf === "number" ? claims.nbf : 0;
  if (!exp || exp + CLOCK_SKEW_SECONDS <= now) {
    throw new RuntimeAuthError("Runtime token has expired.");
  }
  if (nbf && nbf - CLOCK_SKEW_SECONDS > now) {
    throw new RuntimeAuthError("Runtime token is not yet valid.");
  }
}

async function fetchJwks(tenant: string): Promise<Jwk[]> {
  const cached = jwksCache.get(tenant);
  const now = Date.now();
  if (cached && cached.expires > now) return cached.keys;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), JWKS_TIMEOUT_MS);
  try {
    const response = await fetch(
      `https://login.microsoftonline.com/${tenant}/discovery/v2.0/keys`,
      { signal: controller.signal },
    );
    if (!response.ok) throw new RuntimeAuthError("Runtime token keys unavailable.");
    const body = (await response.json()) as { keys?: Jwk[] };
    const keys = Array.isArray(body.keys) ? body.keys : [];
    jwksCache.set(tenant, { expires: now + 60 * 60 * 1000, keys });
    return keys;
  } finally {
    clearTimeout(timeout);
  }
}

async function verifyEntraToken(
  token: string,
  claims: RuntimeClaims,
  environment: Environment,
): Promise<void> {
  const { header } = decodeJwt(token);
  if (header.alg !== "RS256") {
    throw new RuntimeAuthError("Runtime token algorithm is not trusted.");
  }
  const keyId = text(header.kid) || text(header.x5t);
  if (!keyId) throw new RuntimeAuthError("Runtime token key id is missing.");

  const tenant = validateIssuer(claims, environment);
  const keys = await fetchJwks(tenant);
  const key = keys.find((entry) => entry.kid === keyId || entry.x5t === keyId);
  if (!key) throw new RuntimeAuthError("Runtime token key is not trusted.");

  const [encodedHeader, encodedPayload, encodedSignature] = token.split(".");
  const valid = crypto.verify(
    "RSA-SHA256",
    Buffer.from(`${encodedHeader}.${encodedPayload}`),
    crypto.createPublicKey({ key: key as never, format: "jwk" }),
    Buffer.from(encodedSignature, "base64url"),
  );
  if (!valid) throw new RuntimeAuthError("Runtime token signature is invalid.");
}

export async function requireRuntimePrincipal(
  headers: Headers,
  environment: Environment = process.env,
  options: RuntimeAuthOptions = {},
): Promise<RuntimePrincipal> {
  const token = bearer(headers);
  const sharedSecretPrincipal = principalFromSharedSecret(token, environment);
  if (sharedSecretPrincipal) return sharedSecretPrincipal;

  const { claims } = decodeJwt(token);
  const now = Math.floor((options.now ? options.now() : Date.now()) / 1000);
  const tenantId = validateIssuer(claims, environment);
  validateAudience(claims, environment);
  validateLifetime(claims, now);
  await (options.verifyToken ?? verifyEntraToken)(token, claims, environment);

  const allowed = commaList(environment[RUNTIME_PRINCIPAL_IDS_ENV]);
  if (allowed.length === 0) {
    throw new RuntimeAuthError(
      `No runtime principals are configured. Set ${RUNTIME_PRINCIPAL_IDS_ENV}.`,
      403,
    );
  }
  const oid = text(claims.oid).toLowerCase();
  if (!oid || !allowed.includes(oid)) {
    throw new RuntimeAuthError("Runtime principal is not allowed.", 403);
  }
  return { oid, tenantId };
}

export function runtimeReadableDocument(name: string): DocumentName {
  return assertDocumentName(name);
}

export function runtimeWritableDocument(name: string): DocumentName {
  const document = assertDocumentName(name);
  if (document !== CATALOGUE_DOCUMENT) {
    throw new ConfigValidationError("Only catalogue.json may be written.");
  }
  return document;
}

export function runtimeBundlePath(name: string, sha256WithExtension: string): string {
  const sha256 = sha256WithExtension.replace(/\.zip$/u, "");
  if (
    sha256WithExtension !== `${sha256}.zip` ||
    !BUNDLE_NAME.test(name) ||
    !BUNDLE_SHA.test(sha256)
  ) {
    throw new ConfigValidationError("Invalid skill bundle path.");
  }
  return `bundles/${name}/${sha256}.zip`;
}

export function runtimeArtifactPath(
  owner: string,
  id: string,
  filename: string,
): string {
  if (!owner) throw new ConfigValidationError("Invalid artifact owner.");
  return artifactStoragePath(id, filename, owner);
}

export async function readBoundedBody(
  request: Request,
  limit = MAX_ARTIFACT_BYTES,
): Promise<Buffer> {
  const rawLength = request.headers.get("content-length");
  const declared = rawLength ? Number(rawLength) : 0;
  if (Number.isFinite(declared) && declared > limit) {
    throw new PayloadTooLargeError("Request body is too large.");
  }
  if (!request.body) return Buffer.alloc(0);

  const chunks: Buffer[] = [];
  let total = 0;
  const reader = request.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    total += chunk.byteLength;
    if (total > limit) throw new PayloadTooLargeError("Request body is too large.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
