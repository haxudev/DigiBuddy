/**
 * Turns the admin documents into the shape the chat surface renders: what each
 * profile is, and which skills, tools and MCP servers it can reach.
 *
 * A profile stores `null` for "every packaged capability" and an array to
 * restrict itself to those entries, so resolving always happens against the
 * runtime-published catalogue rather than against the profile alone.
 */

import type { Catalogue, McpDocument, ProfileDocument } from "./admin-config";

export type ProfileCapabilities = {
  name: string;
  display_name: string;
  description: string;
  skills: string[];
  tools: string[];
  mcp_servers: string[];
};

/** `null` keeps the whole catalogue; an array keeps only catalogued entries. */
function resolve(selection: string[] | null, catalogue: string[]): string[] {
  if (selection === null) return [...catalogue];
  return selection.filter((entry) => catalogue.includes(entry));
}

export function describeProfiles(
  profiles: ProfileDocument[],
  catalogue: Catalogue,
  mcp: McpDocument,
): ProfileCapabilities[] {
  // A disabled server is never started, so it is not a capability of any
  // profile that happens to list it.
  const enabled = catalogue.mcp_servers.filter(
    (name) => mcp.servers[name]?.enabled !== false,
  );
  return profiles.map((profile) => ({
    name: profile.name,
    display_name: profile.display_name,
    description: profile.description,
    skills: resolve(profile.skills, catalogue.skills),
    tools: resolve(profile.tools, catalogue.tools),
    mcp_servers: resolve(profile.mcp_servers, enabled),
  }));
}
