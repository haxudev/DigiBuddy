/**
 * What each conversation is doing, independently of which one is on screen.
 *
 * The console used to hold one `isRunning`, one activity list and one agent,
 * which meant "the conversation the reader is looking at" and "the conversation
 * that is running" were the same thing by construction. Switching sessions then
 * had to abort the run to keep that assumption true, and a turn someone was
 * waiting on died because they clicked away from it.
 *
 * These are the plain shapes behind the fix: state keyed by session id, so a
 * run belongs to its conversation and the view is just a lookup.
 */

/** A conversation with no turn in flight. */
export const IDLE_RUN: RunState = { running: false, startedAt: 0 };

export type RunState = {
  running: boolean;
  /** When the turn was sent, so the wait can be counted honestly. */
  startedAt: number;
};

export type RunStates = Record<string, RunState>;

export function runState(runs: RunStates, sessionId: string): RunState {
  return runs[sessionId] ?? IDLE_RUN;
}

/** Mark a conversation as started, without touching any other. */
export function startRun(
  runs: RunStates,
  sessionId: string,
  startedAt: number,
): RunStates {
  return { ...runs, [sessionId]: { running: true, startedAt } };
}

/**
 * Mark a conversation as finished.
 *
 * The entry is dropped rather than set to idle, so a store of long-lived state
 * does not grow one entry per conversation ever opened.
 */
export function finishRun(runs: RunStates, sessionId: string): RunStates {
  if (!(sessionId in runs)) return runs;
  const next = { ...runs };
  delete next[sessionId];
  return next;
}

export function isRunning(runs: RunStates, sessionId: string): boolean {
  return runState(runs, sessionId).running;
}

/**
 * Per-session values with a shared empty default.
 *
 * The identity of the fallback matters: React re-renders when a `useMemo`
 * dependency changes identity, so a fresh `[]` for every idle conversation
 * would rerender the transcript on every keystroke.
 */
export function forSession<T>(
  map: Record<string, T[]>,
  sessionId: string,
  empty: T[],
): T[] {
  return map[sessionId] ?? empty;
}

/** Replace one session's list, leaving the rest untouched. */
export function setForSession<T>(
  map: Record<string, T[]>,
  sessionId: string,
  next: T[],
): Record<string, T[]> {
  return { ...map, [sessionId]: next };
}

/** Forget a session entirely, for when the conversation is deleted. */
export function dropSession<T>(
  map: Record<string, T>,
  sessionId: string,
): Record<string, T> {
  if (!(sessionId in map)) return map;
  const next = { ...map };
  delete next[sessionId];
  return next;
}
