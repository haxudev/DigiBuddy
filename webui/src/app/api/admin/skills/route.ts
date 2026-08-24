import { requireAdmin } from "@/lib/admin-auth";
import {
  ConfigValidationError,
  buildConfigStore,
  type DeployedSkill,
} from "@/lib/admin-config";
import {
  audit,
  bundleFromForm,
  deployBundle,
  failure,
  readRegistry,
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

/** Enable, disable or re-describe a deployed skill. */
export async function PATCH(request: Request) {
  try {
    const principal = requireAdmin(request.headers);
    const body = (await request.json().catch(() => {
      throw new ConfigValidationError("Request body must be JSON.");
    })) as Record<string, unknown>;
    const name = String(body.name ?? "").trim();

    const store = buildConfigStore();
    const current = await readRegistry(store);
    const target = current.find((skill) => skill.name === name);
    if (!target) throw new ConfigValidationError(`No such deployed skill: ${name}`);

    const patched: DeployedSkill = {
      ...target,
      enabled: typeof body.enabled === "boolean" ? body.enabled : target.enabled,
      description:
        typeof body.description === "string"
          ? body.description.trim()
          : target.description,
    };
    const skills = await writeRegistry(store, [
      ...current.filter((skill) => skill.name !== name),
      patched,
    ]);
    audit(principal, patched.enabled ? "enabled" : "disabled", name);
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
    const current = await readRegistry(store);
    const target = current.find((skill) => skill.name === name);
    if (!target) throw new ConfigValidationError(`No such deployed skill: ${name}`);

    const skills = await writeRegistry(
      store,
      current.filter((skill) => skill.name !== name),
    );
    await store.deleteBundle(target.bundle).catch(() => undefined);
    audit(principal, "withdrawn", name);
    return Response.json({ skills });
  } catch (error) {
    return failure(error);
  }
}
