import { requireAdmin } from "@/lib/admin-auth";
import { ConfigValidationError } from "@/lib/admin-config";
import {
  bundleFromForm,
  failure,
  fetchArchive,
  importAllowlist,
  previewBundle,
} from "@/lib/skill-import";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Which hosts URL import will accept, so the console can offer or hide it. */
export async function GET(request: Request) {
  try {
    requireAdmin(request.headers);
    return Response.json(
      { allowed_hosts: importAllowlist() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return failure(error);
  }
}

/**
 * Dry run: report what deploying an archive would create, without writing.
 *
 * An archive can yield a dozen skills, and an administrator should see their
 * names, descriptions and contents before changing what every agent can do.
 */
export async function POST(request: Request) {
  try {
    requireAdmin(request.headers);
    const type = request.headers.get("content-type") ?? "";

    if (type.includes("application/json")) {
      const body = (await request.json().catch(() => {
        throw new ConfigValidationError("Request body must be JSON.");
      })) as Record<string, unknown>;
      const source = String(body.source ?? "").trim();
      if (!source) throw new ConfigValidationError("Provide the archive URL as `source`.");
      const archive = await fetchArchive(source);
      return Response.json({
        source: archive.url,
        ...previewBundle(archive.payload, archive.fileName),
      });
    }

    const { payload, fileName } = await bundleFromForm(request);
    return Response.json(previewBundle(payload, fileName));
  } catch (error) {
    return failure(error);
  }
}
