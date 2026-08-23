import {
  AdminAuthError,
  requireAdmin,
  type AdminPrincipal,
} from "@/lib/admin-auth";
import {
  ConfigValidationError,
  SKILLS_DOCUMENT,
  buildConfigStore,
  normaliseSkills,
  type ConfigStore,
  type DeployedSkill,
} from "@/lib/admin-config";
import {
  MAX_BUNDLE_BYTES,
  SkillBundleError,
  inspectBundle,
} from "@/lib/skill-bundle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function failure(error: unknown): Response {
  if (error instanceof AdminAuthError) {
    return Response.json({ error: error.message }, { status: 403 });
  }
  if (error instanceof SkillBundleError || error instanceof ConfigValidationError) {
    return Response.json({ error: error.message }, { status: 400 });
  }
  console.error("admin skills request failed", error);
  return Response.json({ error: "The skill registry is unavailable." }, { status: 500 });
}

function audit(principal: AdminPrincipal, action: string, skill: string): void {
  // Deploying a skill changes what every assembled agent can do, so who did
  // what must be recoverable from the logs.
  console.info(
    `admin skill ${action} name=${skill} by=${principal.id || principal.name}`,
  );
}

/** Bundles are content-addressed, so the version is only a human-readable label. */
function nextVersion(previous: string | undefined): string {
  const number = Number(previous);
  return Number.isFinite(number) && number > 0 ? String(number + 1) : "1";
}

async function readRegistry(store: ConfigStore): Promise<DeployedSkill[]> {
  return normaliseSkills(await store.read(SKILLS_DOCUMENT)).skills;
}

async function saveRegistry(
  store: ConfigStore,
  skills: DeployedSkill[],
): Promise<DeployedSkill[]> {
  const document = normaliseSkills({ skills });
  await store.write(SKILLS_DOCUMENT, document);
  return document.skills;
}

export async function GET(request: Request) {
  try {
    requireAdmin(request.headers);
    const skills = await readRegistry(buildConfigStore());
    return Response.json({ skills }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return failure(error);
  }
}

/** Upload a bundle and deploy it, replacing any earlier version of that skill. */
export async function POST(request: Request) {
  try {
    const principal = requireAdmin(request.headers);

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw new ConfigValidationError("Upload the bundle as multipart/form-data.");
    }
    const file = form.get("bundle");
    if (!(file instanceof File)) {
      throw new ConfigValidationError("Attach the skill bundle as `bundle`.");
    }
    if (file.size > MAX_BUNDLE_BYTES) {
      throw new SkillBundleError(
        `A bundle may be at most ${MAX_BUNDLE_BYTES / (1024 * 1024)} MB.`,
      );
    }

    const payload = Buffer.from(await file.arrayBuffer());
    const inspected = inspectBundle(payload, file.name);
    const description = String(form.get("description") ?? "").trim();
    const version = String(form.get("version") ?? "").trim();

    const store = buildConfigStore();
    const current = await readRegistry(store);
    const previous = current.find((skill) => skill.name === inspected.name);

    const deployed: DeployedSkill = {
      name: inspected.name,
      version: version || nextVersion(previous?.version),
      description: description || previous?.description || "",
      bundle: `bundles/${inspected.name}/${inspected.sha256}.zip`,
      sha256: inspected.sha256,
      size: inspected.size,
      enabled: previous?.enabled ?? true,
      uploaded_at: new Date().toISOString(),
      uploaded_by: principal.id || principal.name,
    };

    // The bundle must exist before the registry names it, or the runtime would
    // briefly see an entry it cannot fetch.
    await store.writeBundle(deployed.bundle, payload);
    const skills = await saveRegistry(store, [
      ...current.filter((skill) => skill.name !== deployed.name),
      deployed,
    ]);
    if (previous && previous.bundle !== deployed.bundle) {
      await store.deleteBundle(previous.bundle).catch(() => undefined);
    }
    audit(principal, "deployed", deployed.name);

    return Response.json({ skill: deployed, skills, entries: inspected.entries });
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
    const skills = await saveRegistry(store, [
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

    const skills = await saveRegistry(
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
