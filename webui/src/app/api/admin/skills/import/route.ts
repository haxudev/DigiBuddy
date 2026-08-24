import { requireAdmin } from "@/lib/admin-auth";
import { ConfigValidationError, buildConfigStore } from "@/lib/admin-config";
import { audit, deployBundle, failure, fetchArchive } from "@/lib/skill-import";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Deploy an archive straight from a URL.
 *
 * The URL is only a way to obtain bytes. They go through the same explosion and
 * the same content-addressed store as an upload, and the runtime still verifies
 * the digest it reads back, so nothing about the network becomes trusted.
 */
export async function POST(request: Request) {
  try {
    const principal = requireAdmin(request.headers);
    const body = (await request.json().catch(() => {
      throw new ConfigValidationError("Request body must be JSON.");
    })) as Record<string, unknown>;

    const source = String(body.source ?? "").trim();
    if (!source) throw new ConfigValidationError("Provide the archive URL as `source`.");

    const archive = await fetchArchive(source);
    const result = await deployBundle(
      buildConfigStore(),
      archive.payload,
      archive.fileName,
      {
        description: String(body.description ?? "").trim(),
        version: String(body.version ?? "").trim(),
        by: principal.id || principal.name,
        source: archive.url,
      },
    );
    for (const skill of result.deployed) audit(principal, "imported", skill.name);

    return Response.json({
      source: archive.url,
      deployed: result.deployed,
      skills: result.skills,
      layout: result.layout,
      notes: result.notes,
    });
  } catch (error) {
    return failure(error);
  }
}
