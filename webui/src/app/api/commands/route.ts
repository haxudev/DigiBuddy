import {
  CATALOGUE_DOCUMENT,
  COMMANDS_DOCUMENT,
  MCP_DOCUMENT,
  PROFILES_DOCUMENT,
  buildConfigStore,
} from "@/lib/admin-config";
import { NotSignedInError, requirePrincipal } from "@/lib/identity";
import { resolveUserCommands } from "@/lib/user-commands";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The slash commands a chat user may run.
 *
 * Scoped to a profile, because a command is only real if the skills behind it
 * are ones that profile can reach. The runtime enforces the same rule when the
 * turn arrives; this exists so the menu does not offer a row that would then do
 * nothing.
 *
 * Signed in, like the turn it precedes. This lists what the deployment can do,
 * including every skill an administrator has uploaded, so it should not answer
 * anyone who could not send the message the list is for.
 */
export async function GET(request: Request) {
  try {
    requirePrincipal(request.headers);
  } catch (error) {
    if (error instanceof NotSignedInError) {
      return Response.json({ error: error.message }, { status: 403 });
    }
    throw error;
  }

  const requested =
    new URL(request.url).searchParams.get("profile")?.trim() ||
    process.env.DIGIBUDDY_PROFILE?.trim() ||
    "";
  try {
    const store = buildConfigStore();
    const [catalogueDocument, commandsDocument, profilesDocument, mcpDocument] =
      await Promise.all([
        store.read(CATALOGUE_DOCUMENT),
        store.read(COMMANDS_DOCUMENT),
        store.read(PROFILES_DOCUMENT),
        store.read(MCP_DOCUMENT),
      ]);

    return Response.json(
      {
        commands: resolveUserCommands(
          catalogueDocument,
          commandsDocument,
          profilesDocument,
          mcpDocument,
          requested,
        ),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    // An unseeded or unreachable store is not something the composer can act
    // on. An empty menu leaves `@`, attachments and plain messages working,
    // which is better than failing the page over one missing document.
    return Response.json(
      { commands: [] },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
}
