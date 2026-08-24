import {
  CATALOGUE_DOCUMENT,
  MCP_DOCUMENT,
  PROFILES_DOCUMENT,
  buildConfigStore,
  normaliseCatalogue,
  normaliseMcp,
  normaliseProfiles,
} from "@/lib/admin-config";
import { describeProfiles } from "@/lib/profile-capabilities";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The profiles a chat user may pick from, together with the capabilities each
 * one carries. Endpoints, keys and tokens stay on the admin surface; only the
 * names a reader needs to understand what the agent can do are exposed.
 */
export async function GET() {
  try {
    const store = buildConfigStore();
    const [profilesDocument, catalogueDocument, mcpDocument] = await Promise.all([
      store.read(PROFILES_DOCUMENT),
      store.read(CATALOGUE_DOCUMENT),
      store.read(MCP_DOCUMENT),
    ]);
    return Response.json(
      {
        profiles: describeProfiles(
          normaliseProfiles(profilesDocument).profiles,
          normaliseCatalogue(catalogueDocument),
          normaliseMcp(mcpDocument),
        ),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    // An unconfigured or unreachable store simply means "no profile choice".
    return Response.json({ profiles: [] }, { headers: { "Cache-Control": "no-store" } });
  }
}
