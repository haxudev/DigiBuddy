import {
  AdminAuthError,
  requireAdmin,
  type AdminPrincipal,
} from "@/lib/admin-auth";
import {
  ConfigConflictError,
  ConfigValidationError,
  buildConfigStore,
} from "@/lib/admin-config";
import {
  applyCredentialChange,
  readCredentialStatuses,
  type CredentialAction,
} from "@/lib/credentials";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function failure(error: unknown): Response {
  if (error instanceof AdminAuthError) {
    return Response.json({ error: error.message }, { status: 403 });
  }
  if (error instanceof ConfigConflictError) {
    return Response.json({ error: error.message }, { status: 409 });
  }
  if (error instanceof ConfigValidationError) {
    return Response.json({ error: error.message }, { status: 400 });
  }
  console.error("admin credential request failed", error);
  return Response.json(
    { error: "Profile credentials are unavailable." },
    { status: 500 },
  );
}

function audit(
  principal: AdminPrincipal,
  action: string,
  profile: string,
  slot: string,
): void {
  // Which agent gained or lost which capability, and who did it. The value is
  // the one thing that must never appear here.
  console.info(
    `admin credential ${action} profile=${profile} slot=${slot} by=${principal.id || principal.name}`,
  );
}

/**
 * Which slots each profile has bound. Never what they are bound to.
 *
 * There is no endpoint that returns a credential value, by design: an
 * administrator who needs a different one rotates it rather than reading the
 * current one back.
 */
export async function GET(request: Request) {
  try {
    requireAdmin(request.headers);
    return Response.json(
      { credentials: await readCredentialStatuses(buildConfigStore()) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return failure(error);
  }
}

/** Rotate or clear exactly one binding. */
export async function PUT(request: Request) {
  try {
    const principal = requireAdmin(request.headers);
    const body = (await request.json().catch(() => {
      throw new ConfigValidationError("Request body must be JSON.");
    })) as Record<string, unknown>;

    const profile = String(body.profile ?? "").trim();
    const slot = String(body.slot ?? "").trim();
    const action = String(body.action ?? "rotate").trim() as CredentialAction;
    if (action !== "rotate" && action !== "clear") {
      throw new ConfigValidationError("Action must be `rotate` or `clear`.");
    }

    const credentials = await applyCredentialChange(buildConfigStore(), {
      profile,
      slot,
      action,
      value: typeof body.value === "string" ? body.value : "",
      by: principal.id || principal.name,
    });
    audit(principal, action === "clear" ? "cleared" : "rotated", profile, slot);
    return Response.json({ credentials });
  } catch (error) {
    return failure(error);
  }
}
