import {
  ChatSession,
  SESSIONS_STORAGE_KEY,
  createSession,
  parseSessions,
  serializeSessions,
} from "./sessions";

/**
 * Sessions are browser state, not React state: `useSyncExternalStore` reads
 * them so the server render and the hydrated client agree, and so the AG-UI
 * subscription can update a session without reaching back into a component.
 */
const EMPTY: ChatSession[] = [];

let sessions: ChatSession[] = EMPTY;
let loaded = false;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function persist() {
  try {
    window.localStorage.setItem(SESSIONS_STORAGE_KEY, serializeSessions(sessions));
  } catch {
    // A full or blocked storage quota must not break the conversation.
  }
}

function load() {
  if (loaded) return;
  loaded = true;
  let stored: ChatSession[] = [];
  try {
    stored = parseSessions(window.localStorage.getItem(SESSIONS_STORAGE_KEY));
  } catch {
    stored = [];
  }
  sessions = stored.length ? stored : [createSession()];
}

export function subscribeSessions(listener: () => void): () => void {
  load();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getSessions(): ChatSession[] {
  return sessions;
}

export function getServerSessions(): ChatSession[] {
  return EMPTY;
}

export function getSession(sessionId: string): ChatSession | undefined {
  return sessions.find((session) => session.id === sessionId);
}

export function replaceSessions(next: ChatSession[]): void {
  sessions = next.length ? next : [createSession()];
  persist();
  emit();
}

export function updateSession(
  sessionId: string,
  change: (session: ChatSession) => ChatSession,
): void {
  const index = sessions.findIndex((session) => session.id === sessionId);
  if (index === -1) return;
  const next = sessions.slice();
  next[index] = change(sessions[index]);
  sessions = next;
  persist();
  emit();
}

/** Test-only reset so module state does not leak between cases. */
export function resetSessionStore(): void {
  sessions = EMPTY;
  loaded = false;
  listeners.clear();
}
