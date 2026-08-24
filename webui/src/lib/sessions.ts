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
  createdAt: number;
  updatedAt: number;
};

export const SESSIONS_STORAGE_KEY = "digibuddy.sessions.v1";

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
    requestedProfile,
    boundProfile: "",
    messages: [],
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
      createdAt: typeof value.createdAt === "number" ? value.createdAt : 0,
      updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : 0,
    });
  }
  return sessions;
}

export function serializeSessions(sessions: ChatSession[]): string {
  return JSON.stringify(sessions);
}
