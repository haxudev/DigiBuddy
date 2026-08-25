import {
  createSession,
  parseSessions,
  serializeSessions,
  sessionsStorageKey,
  type ChatSession,
} from "./sessions.ts";

/**
 * Sessions are browser state, not React state: `useSyncExternalStore` reads
 * them so the server render and the hydrated client agree, and so the AG-UI
 * subscription can update a session without reaching back into a component.
 */
const EMPTY: ChatSession[] = [];

let sessions: ChatSession[] = EMPTY;
let loaded = false;
let owner = "";
const listeners = new Set<() => void>();

/**
 * Point the store at one account's conversations.
 *
 * Switching identity discards what is in memory rather than merging it: the
 * previous account's threads are not this account's to resume.
 */
export function setSessionOwner(next: string): void {
  if (next === owner) return;
  owner = next;
  loaded = false;
  sessions = EMPTY;
  emit();
}

function emit() {
  for (const listener of listeners) listener();
}

function persist() {
  try {
    window.localStorage.setItem(sessionsStorageKey(owner), serializeSessions(sessions));
  } catch {
    // A full or blocked storage quota must not break the conversation.
  }
}

function load() {
  if (loaded) return;
  loaded = true;
  let stored: ChatSession[] = [];
  try {
    stored = parseSessions(window.localStorage.getItem(sessionsStorageKey(owner)));
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
  // `setSessionOwner` invalidates the in-memory namespace after the component
  // has already subscribed. React asks for a fresh snapshot after that emit,
  // so the snapshot getter must reload the new owner's sessions.
  load();
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
  owner = "";
  listeners.clear();
}
