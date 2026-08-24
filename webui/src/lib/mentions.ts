/**
 * Addressing an agent with `@`.
 *
 * Deliberately narrow: only a leading `@query` in an otherwise empty composer
 * counts. Under the session-level binding rule a mention anywhere else cannot
 * change anything -- Codex fixes a thread's base instructions when the thread
 * starts -- so parsing one would promise a capability the runtime does not
 * have. A user who types `@marketing` mid-sentence means the word, not a
 * routing instruction.
 */

import type { ProfileCapabilities } from "./profile-capabilities.ts";

export type MentionQuery = {
  /** What follows the `@`, lowercased. Empty right after typing `@`. */
  query: string;
};

const LEADING_MENTION = /^@([\w-]*)$/;

/** The mention being typed, or `null` when this is ordinary prose. */
export function mentionQuery(composer: string): MentionQuery | null {
  const match = LEADING_MENTION.exec(composer.trimStart());
  if (!match) return null;
  // A trailing space ends the mention: the user moved on to the message.
  if (composer.trimStart() !== composer.trim()) return null;
  return { query: match[1].toLowerCase() };
}

/**
 * Agents worth offering for a query, most relevant first.
 *
 * Matches the canonical name and the display name, because the reader sees the
 * display name and the runtime only accepts the canonical one.
 */
export function matchProfiles(
  profiles: ProfileCapabilities[],
  query: string,
): ProfileCapabilities[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...profiles];
  const scored = profiles
    .map((profile) => {
      const name = profile.name.toLowerCase();
      const display = (profile.display_name || "").toLowerCase();
      if (name === needle) return { profile, rank: 0 };
      if (name.startsWith(needle) || display.startsWith(needle)) {
        return { profile, rank: 1 };
      }
      if (name.includes(needle) || display.includes(needle)) {
        return { profile, rank: 2 };
      }
      return null;
    })
    .filter((entry) => entry !== null);
  scored.sort(
    (left, right) =>
      left.rank - right.rank || left.profile.name.localeCompare(right.profile.name),
  );
  return scored.map((entry) => entry.profile);
}

/**
 * Resolve a typed mention to exactly one agent.
 *
 * Ambiguity resolves to nothing rather than to a guess: silently starting a
 * conversation with the wrong agent is worse than asking again, and the agent
 * decides which credentials the turn can reach.
 */
export function resolveMention(
  profiles: ProfileCapabilities[],
  query: string,
): ProfileCapabilities | null {
  const matches = matchProfiles(profiles, query);
  if (matches.length === 0) return null;
  const needle = query.trim().toLowerCase();
  const exact = matches.find((profile) => profile.name.toLowerCase() === needle);
  if (exact) return exact;
  return matches.length === 1 ? matches[0] : null;
}

/** Remove the mention token, leaving the message the user actually wrote. */
export function stripMention(composer: string): string {
  return composer.replace(/^\s*@[\w-]*\s*/, "");
}
