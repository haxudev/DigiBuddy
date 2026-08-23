import {
  PROFILES_DOCUMENT,
  buildConfigStore,
  normaliseProfiles,
} from "@/lib/admin-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The profiles a chat user may pick from. Only the labels are exposed: personas
 * and capability assembly are runtime concerns and stay on the admin surface.
 */
export async function GET() {
  try {
    const document = await buildConfigStore().read(PROFILES_DOCUMENT);
    const { profiles } = normaliseProfiles(document);
    return Response.json(
      {
        profiles: profiles.map(({ name, display_name, description }) => ({
          name,
          display_name,
          description,
        })),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    // An unconfigured or unreachable store simply means "no profile choice".
    return Response.json({ profiles: [] }, { headers: { "Cache-Control": "no-store" } });
  }
}
