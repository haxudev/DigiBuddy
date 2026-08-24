/**
 * The agent a conversation is actually running.
 *
 * The binding lives on the server: a blank request may resolve through a
 * deployment default, and a resumed conversation keeps the profile it was
 * started with. So the console is told, rather than assuming its own request
 * took effect. The answer travels as an invisible comment on the assistant
 * message, the same transport the artifact manifest uses, because the Responses
 * protocol has no field for it.
 */

const PROFILE_COMMENT = /<!--\s*digibuddy-profile:(\{[\s\S]*?\})\s*-->/g;

/** Mirrors `hosted-agent/codex_adapter/client.py`. */
export type BindingStatus = "bound" | "contradicted";

export type EffectiveProfile = {
  /** Canonical profile name, or "" when the runtime has no profiles at all. */
  profile: string;
  display_name: string;
  /** What the client asked for, so a contradiction can be explained. */
  requested: string;
  status: BindingStatus;
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Read the effective profile out of an assistant message.
 *
 * The last one wins: a transcript may hold several turns, and the most recent
 * is the one describing the binding now in force.
 */
export function extractEffectiveProfile(
  message: string,
): EffectiveProfile | null {
  PROFILE_COMMENT.lastIndex = 0;
  let found: EffectiveProfile | null = null;
  for (const match of message.matchAll(PROFILE_COMMENT)) {
    let payload: unknown;
    try {
      payload = JSON.parse(match[1]);
    } catch {
      continue;
    }
    const raw =
      payload && typeof payload === "object"
        ? ((payload as Record<string, unknown>).profile as unknown)
        : null;
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const profile = text(entry.profile);
    if (!profile) continue;
    found = {
      profile,
      display_name: text(entry.display_name) || profile,
      requested: text(entry.requested),
      status: entry.status === "contradicted" ? "contradicted" : "bound",
    };
  }
  return found;
}

/** Remove the marker so it never reaches the reader. */
export function stripProfileMetadata(message: string): string {
  PROFILE_COMMENT.lastIndex = 0;
  return message.replace(PROFILE_COMMENT, "");
}
