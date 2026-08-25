/**
 * Resolve the slash-command menu from the persisted user-plane documents.
 *
 * The route catches store failures because the composer can still send normal
 * messages without slash commands. The policy for healthy documents lives here
 * so the profile scoping is tested with the rest of the command logic.
 */

import {
  normaliseCatalogue,
  normaliseMcp,
  normaliseProfiles,
  type JsonDocument,
} from "./admin-config.ts";
import {
  DEFAULT_PROFILE_NAME,
  describeProfiles,
} from "./profile-capabilities.ts";
import {
  normaliseCommands,
  resolveCommands,
  type SkillCommand,
} from "./skill-commands.ts";

export function resolveUserCommands(
  catalogueDocument: JsonDocument | null,
  commandsDocument: JsonDocument | null,
  profilesDocument: JsonDocument | null,
  mcpDocument: JsonDocument | null,
  requestedProfile: string,
): SkillCommand[] {
  const catalogue = normaliseCatalogue(catalogueDocument);
  const profiles = describeProfiles(
    normaliseProfiles(profilesDocument).profiles,
    catalogue,
    normaliseMcp(mcpDocument),
  );

  const configured = profiles.length > 0;
  const effectiveName = requestedProfile || DEFAULT_PROFILE_NAME;
  const active = profiles.find((profile) => profile.name === effectiveName);
  if (active) {
    return resolveCommands(
      catalogue,
      normaliseCommands(commandsDocument),
      active.skills,
    );
  }

  // Before a profiles document exists, the runtime uses its unrestricted
  // built-in default. Once profiles are configured, omission is policy: a name
  // no profile answers to must not widen back to the whole catalogue.
  if (!configured && !requestedProfile) {
    return resolveCommands(
      catalogue,
      normaliseCommands(commandsDocument),
      catalogue.skills,
    );
  }

  // A name no profile answers to is not the default. Falling back to the whole
  // catalogue here would make `?profile=anything` the most permissive answer
  // the endpoint can give, and would list every skill the deployment ships --
  // including uploaded ones -- in a deployment whose every configured profile
  // is restricted. An unanswerable name gets nothing.
  return [];
}
