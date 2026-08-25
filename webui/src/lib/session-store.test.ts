import assert from "node:assert/strict";
import test from "node:test";

import {
  getSessions,
  resetSessionStore,
  setSessionOwner,
  subscribeSessions,
} from "./session-store.ts";
import {
  createSession,
  serializeSessions,
  sessionsStorageKey,
} from "./sessions.ts";

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

test("switching identity reloads that owner's sessions", () => {
  const storage = new MemoryStorage();
  const anonymous = createSession("", 1);
  const signedIn = createSession("digibuddy", 2);
  storage.setItem(sessionsStorageKey(), serializeSessions([anonymous]));
  storage.setItem(sessionsStorageKey("owner-a"), serializeSessions([signedIn]));
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage: storage },
  });

  try {
    resetSessionStore();
    const unsubscribe = subscribeSessions(() => undefined);
    assert.equal(getSessions()[0].id, anonymous.id);

    setSessionOwner("owner-a");

    assert.equal(getSessions()[0].id, signedIn.id);
    unsubscribe();
  } finally {
    resetSessionStore();
    Reflect.deleteProperty(globalThis, "window");
  }
});

test("a new owner gets a usable initial session", () => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage: new MemoryStorage() },
  });

  try {
    resetSessionStore();
    const unsubscribe = subscribeSessions(() => undefined);
    setSessionOwner("owner-b");

    assert.equal(getSessions().length, 1);
    assert.ok(getSessions()[0].threadId);
    unsubscribe();
  } finally {
    resetSessionStore();
    Reflect.deleteProperty(globalThis, "window");
  }
});