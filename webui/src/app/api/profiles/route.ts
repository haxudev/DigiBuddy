import {
  CATALOGUE_DOCUMENT,
  MCP_DOCUMENT,
  PROFILES_DOCUMENT,
  buildConfigStore,
  normaliseCatalogue,
  normaliseMcp,
  normaliseProfiles,
} from "@/lib/admin-config";
import {
  defaultProfileCapabilities,
  describeProfiles,
} from "@/lib/profile-capabilities";

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
    const catalogue = normaliseCatalogue(catalogueDocument);
    const mcp = normaliseMcp(mcpDocument);
    const profiles = describeProfiles(
      normaliseProfiles(profilesDocument).profiles,
      catalogue,
      mcp,
    );
    return Response.json(
      {
        status: "ready",
        profiles:
          profiles.length > 0
            ? profiles
            : [
                defaultProfileCapabilities(
                  catalogue,
                  mcp,
                  process.env.DIGIBUDDY_PROFILE?.trim() || undefined,
                ),
              ],
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    // The hosted runtime has this same unrestricted fallback, so the picker
    // remains truthful even before the shared configuration store is seeded.
    // The status still says the capability lists behind these names could not
    // be read, because an empty capability list is a claim of its own.
    console.error("agent profiles unavailable", error);
    return Response.json(
      {
        status: "unavailable",
        profiles: [
          defaultProfileCapabilities(
            { skills: [], tools: [], mcp_servers: [], skill_entries: [] },
            { servers: {} },
            process.env.DIGIBUDDY_PROFILE?.trim() || undefined,
          ),
        ],
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
}
