import { requireAdmin } from "@/lib/admin-auth";
import {
  ConfigValidationError,
  buildConfigStore,
  isExecutable,
  type DeployedSkill,
} from "@/lib/admin-config";
import {
  audit,
  bundleFromForm,
  deployBundle,
  failure,
  readRegistry,
  readRegistryVersioned,
  writeRegistry,
} from "@/lib/skill-import";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    requireAdmin(request.headers);
    const skills = await readRegistry(buildConfigStore());
    return Response.json({ skills }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return failure(error);
  }
}

/**
 * Upload an archive and deploy every skill it holds.
 *
 * A plain single-skill zip deploys as one skill, exactly as before. A repository
 * archive is exploded into one self-contained bundle per skill first.
 */
export async function POST(request: Request) {
  try {
    const principal = requireAdmin(request.headers);
    const { payload, fileName, form } = await bundleFromForm(request);

    const result = await deployBundle(buildConfigStore(), payload, fileName, {
      description: String(form.get("description") ?? "").trim(),
      version: String(form.get("version") ?? "").trim(),
      by: principal.id || principal.name,
      previewed: String(form.get("previewed") ?? "").trim() || undefined,
    });
    for (const skill of result.deployed) audit(principal, "deployed", skill.name);

    return Response.json({
      skill: result.deployed[0],
      deployed: result.deployed,
      skills: result.skills,
      layout: result.layout,
      notes: result.notes,
    });
  } catch (error) {
    return failure(error);
  }
}

/**
 * Enable, disable, re-describe or approve a deployed capability.
 *
 * Approval is separate from enabling because they answer different questions.
 * Enabling asks whether this capability should be offered; approving asks
 * whether *these bytes* may execute. The approval therefore names the digest it
 * consents to, so a later deploy of different code cannot inherit it.
 */
export async function PATCH(request: Request) {
  try {
    const principal = requireAdmin(request.headers);
    const body = (await request.json().catch(() => {
      throw new ConfigValidationError("Request body must be JSON.");
    })) as Record<string, unknown>;
    const name = String(body.name ?? "").trim();

    const store = buildConfigStore();
    const { skills: current, revision } = await readRegistryVersioned(store);
    const target = current.find((skill) => skill.name === name);
    if (!target) throw new ConfigValidationError(`No such deployed skill: ${name}`);

    let approval = {
      approved_sha256: target.approved_sha256,
      approved_at: target.approved_at,
      approved_by: target.approved_by,
    };
    const approve = body.approve;
    if (approve !== undefined) {
      if (!isExecutable(target)) {
        throw new ConfigValidationError(
          `${name} is a skill; it is read, not executed, so there is nothing to approve.`,
        );
      }
      if (approve === false) {
        approval = { approved_sha256: "", approved_at: "", approved_by: "" };
      } else {
        // The caller states which bytes it read. Anything else means the
        // console was looking at a version that is no longer deployed.
        const digest = String(body.sha256 ?? "").trim().toLowerCase();
        if (digest !== target.sha256) {
          throw new ConfigValidationError(
            `${name} has changed since it was reviewed. Reload and approve the current version.`,
          );
        }
        approval = {
          approved_sha256: target.sha256,
          approved_at: new Date().toISOString(),
          approved_by: principal.id || principal.name,
        };
      }
    }

    const patched: DeployedSkill = {
      ...target,
      ...approval,
      enabled: typeof body.enabled === "boolean" ? body.enabled : target.enabled,
      description:
        typeof body.description === "string"
          ? body.description.trim()
          : target.description,
    };
    const skills = await writeRegistry(
      store,
      [...current.filter((skill) => skill.name !== name), patched],
      revision,
    );
    audit(
      principal,
      approve === undefined
        ? patched.enabled
          ? "enabled"
          : "disabled"
        : patched.approved_sha256
          ? `approved ${patched.approved_sha256.slice(0, 12)}`
          : "revoked",
      name,
    );
    return Response.json({ skill: patched, skills });
  } catch (error) {
    return failure(error);
  }
}

/** Withdraw a skill: it leaves the registry and its bundle is deleted. */
export async function DELETE(request: Request) {
  try {
    const principal = requireAdmin(request.headers);
    const name = new URL(request.url).searchParams.get("name")?.trim() ?? "";

    const store = buildConfigStore();
    const { skills: current, revision } = await readRegistryVersioned(store);
    const target = current.find((skill) => skill.name === name);
    if (!target) throw new ConfigValidationError(`No such deployed skill: ${name}`);

    // The registry entry goes; the content-addressed bundle stays. It is the
    // only copy of bytes an administrator already approved, and a withdrawal
    // that destroys them cannot be undone.
    const skills = await writeRegistry(
      store,
      current.filter((skill) => skill.name !== name),
      revision,
    );
    audit(principal, "withdrawn", name);
    return Response.json({ skills });
  } catch (error) {
    return failure(error);
  }
}
