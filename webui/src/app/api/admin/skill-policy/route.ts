import {
  readSkillPolicyVersioned,
  skillPolicyPatch,
  skillPolicyRevision,
  toggleSkillPolicy,
  writeSkillPolicy,
} from "@/lib/admin-skill-policy";
import { requireAdmin } from "@/lib/admin-auth";
import {
  ConfigConflictError,
  ConfigValidationError,
  buildConfigStore,
  normaliseSkillPolicy,
} from "@/lib/admin-config";
import { audit, failure } from "@/lib/skill-import";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function conflict(error: ConfigConflictError): ConfigConflictError {
  error.message =
    error.message || "Skill policy changed while you were editing; reload and try again.";
  return error;
}

export async function GET(request: Request) {
  try {
    requireAdmin(request.headers);
    const { disabled, revision } = await readSkillPolicyVersioned(
      buildConfigStore(),
    );
    return Response.json(
      { disabled, revision },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return failure(error);
  }
}

export async function PUT(request: Request) {
  try {
    const principal = requireAdmin(request.headers);
    const body = (await request.json().catch(() => {
      throw new ConfigValidationError("Request body must be JSON.");
    })) as unknown;

    const expectedRevision = skillPolicyRevision(body);
    const store = buildConfigStore();
    const disabled = await writeSkillPolicy(
      store,
      normaliseSkillPolicy(body).disabled,
      expectedRevision,
    ).catch((error) => {
      if (error instanceof ConfigConflictError) throw conflict(error);
      throw error;
    });
    audit(principal, "updated packaged skill policy", "skill-policy.json");
    const { revision } = await readSkillPolicyVersioned(store);
    return Response.json({ disabled, revision });
  } catch (error) {
    return failure(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const principal = requireAdmin(request.headers);
    const body = await request.json().catch(() => {
      throw new ConfigValidationError("Request body must be JSON.");
    });
    const patch = skillPolicyPatch(body);
    const expectedRevision = skillPolicyRevision(body);

    const store = buildConfigStore();
    const { disabled: current } = await readSkillPolicyVersioned(store);
    const disabled = await writeSkillPolicy(
      store,
      toggleSkillPolicy(current, patch),
      expectedRevision,
    ).catch((error) => {
      if (error instanceof ConfigConflictError) throw conflict(error);
      throw error;
    });
    audit(
      principal,
      patch.enabled ? "enabled packaged skill" : "disabled packaged skill",
      patch.name,
    );
    const { revision } = await readSkillPolicyVersioned(store);
    return Response.json({ disabled, revision });
  } catch (error) {
    return failure(error);
  }
}
