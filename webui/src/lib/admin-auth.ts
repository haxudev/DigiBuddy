/**
 * Administrator authorisation.
 *
 * The console is expected to sit behind App Service / Container Apps Easy Auth,
 * which injects the signed-in principal as `x-ms-client-principal`. We do not
 * trust the request to name its own principal: only that header is read, and an
 * explicit allowlist decides who may change runtime configuration.
 */

type Environment = Record<string, string | undefined>;

export type AdminPrincipal = { id: string; name: string };

export class AdminAuthError extends Error {}

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

/**
 * Resolve the caller and confirm they may administer the runtime. Throws rather
 * than returning null so a caller cannot forget to check the result.
 */
export function requireAdmin(
  headers: Headers,
  environment: Environment = process.env,
): AdminPrincipal {
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
