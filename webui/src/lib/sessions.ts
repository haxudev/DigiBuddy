export type StoredMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

export type ChatSession = {
  id: string;
  title: string;
  threadId: string;
  previousResponseId: string;
  /** What this conversation asks the runtime for. Empty means "the default". */
  requestedProfile: string;
  /**
   * The agent the runtime reported actually running. Empty until the first
   * turn answers; once set, the conversation is bound and the choice is no
   * longer the reader's to change, because Codex fixes a thread's base
   * instructions when the thread starts.
   */
  boundProfile: string;
  messages: StoredMessage[];
  /**
   * Which skills each user turn was sent with, keyed by message id.
   *
   * It lives on the session rather than on the message because `messages` is
   * rebuilt wholesale from the agent's own list on every change, so anything
   * hung off a message object would be thrown away on the next token.
   *
   * Presentation only: the runtime is told about skills through request
   * metadata, and the message text is exactly what the user typed.
   */
  turnCommands: Record<string, string[]>;
  createdAt: number;
  updatedAt: number;
};

const SESSIONS_STORAGE_PREFIX = "digibuddy.sessions.v1";

/** Kept for callers that predate sign-in; the anonymous namespace. */
export const SESSIONS_STORAGE_KEY = SESSIONS_STORAGE_PREFIX;

/**
 * Where this account's conversations are kept.
 *
 * Namespaced per signed-in account, because a browser is shared and localStorage
 * is not. Without this, signing out and signing in as someone else would show
 * the previous person's conversations, and the next turn would resume one of
 * their threads.
 */
export function sessionsStorageKey(owner = ""): string {
  return owner ? `${SESSIONS_STORAGE_PREFIX}.${owner}` : SESSIONS_STORAGE_PREFIX;
}

const DEFAULT_TITLE = "New session";
const MAX_TITLE_LENGTH = 48;

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `id-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

export function createSession(
  requestedProfile = "",
  now = Date.now(),
): ChatSession {
  return {
    id: newId(),
    title: DEFAULT_TITLE,
    threadId: newId(),
    previousResponseId: "",
    // Guarded because this is the boundary where browser-persisted state is
    // created, and a caller that passes a handler by reference gets React's
    // event object here instead of a name. An event is not clonable, so it
    // would break the next turn rather than the call that created it.
    requestedProfile: typeof requestedProfile === "string" ? requestedProfile : "",
    boundProfile: "",
    messages: [],
    turnCommands: {},
    createdAt: now,
    updatedAt: now,
  };
}

/** A bound conversation cannot change agent; only a new one can. */
export function isBound(session: ChatSession | undefined): boolean {
  return Boolean(session?.boundProfile);
}

/**
 * Derive a readable tab title from the first user turn. Sessions keep the
 * default title until the user actually says something.
 */
export function deriveTitle(messages: StoredMessage[]): string {
  const first = messages.find(
    (message) => message.role === "user" && message.content.trim(),
  );
  if (!first) return DEFAULT_TITLE;
  const line = first.content.trim().split(/\r?\n/)[0].trim();
  if (line.length <= MAX_TITLE_LENGTH) return line;
  return `${line.slice(0, MAX_TITLE_LENGTH - 1)}…`;
}

export function upsertSession(
  sessions: ChatSession[],
  session: ChatSession,
): ChatSession[] {
  const index = sessions.findIndex((item) => item.id === session.id);
  if (index === -1) return [session, ...sessions];
  const next = sessions.slice();
  next[index] = session;
  return next;
}

export function removeSession(
  sessions: ChatSession[],
  sessionId: string,
): ChatSession[] {
  return sessions.filter((session) => session.id !== sessionId);
}

export function renameSession(
  sessions: ChatSession[],
  sessionId: string,
  title: string,
): ChatSession[] {
  const trimmed = title.trim();
  return sessions.map((session) =>
    session.id === sessionId
      ? { ...session, title: trimmed || DEFAULT_TITLE }
      : session,
  );
}

function isStoredMessage(value: unknown): value is StoredMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  return (
    typeof message.id === "string" &&
    (message.role === "user" || message.role === "assistant") &&
    typeof message.content === "string"
  );
}

/**
 * Read the per-message skill list, dropping anything that is not a list of
 * names. Sessions stored before skills were recorded simply have none, which
 * is why a missing field is an empty map rather than a rejected session.
 */
function parseTurnCommands(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const parsed: Record<string, string[]> = {};
  for (const [id, names] of Object.entries(value as Record<string, unknown>)) {
    if (!id || !Array.isArray(names)) continue;
    const clean = names
      .filter((name): name is string => typeof name === "string" && Boolean(name.trim()))
      .map((name) => name.trim())
      .filter((name, index, all) => all.indexOf(name) === index);
    if (clean.length) parsed[id] = clean;
  }
  return parsed;
}

/**
 * Persisted sessions come from browser storage, which older builds or a user
 * may have corrupted, so every field is validated before it is trusted.
 */
export function parseSessions(raw: string | null): ChatSession[] {
  if (!raw) return [];
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(payload)) return [];

  const sessions: ChatSession[] = [];
  for (const entry of payload) {
    if (!entry || typeof entry !== "object") continue;
    const value = entry as Record<string, unknown>;
    if (typeof value.id !== "string" || !value.id) continue;
    if (typeof value.threadId !== "string" || !value.threadId) continue;
    const messages = Array.isArray(value.messages)
      ? value.messages.filter(isStoredMessage)
      : [];
    sessions.push({
      id: value.id,
      title: typeof value.title === "string" && value.title.trim()
        ? value.title
        : deriveTitle(messages),
      threadId: value.threadId,
      previousResponseId:
        typeof value.previousResponseId === "string"
          ? value.previousResponseId
          : "",
      // Sessions stored before the runtime reported its binding migrate to
      // "unknown" rather than to a guess, so the picker asks again instead of
      // claiming an agent that may never have run.
      requestedProfile:
        typeof value.requestedProfile === "string" ? value.requestedProfile : "",
      boundProfile:
        typeof value.boundProfile === "string" ? value.boundProfile : "",
      messages,
      turnCommands: parseTurnCommands(value.turnCommands),
      createdAt: typeof value.createdAt === "number" ? value.createdAt : 0,
      updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : 0,
    });
  }
  return sessions;
}

export function serializeSessions(sessions: ChatSession[]): string {
  return JSON.stringify(sessions);
}
