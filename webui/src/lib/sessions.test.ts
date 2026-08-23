import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createSession,
  deriveTitle,
  parseSessions,
  removeSession,
  renameSession,
  serializeSessions,
  upsertSession,
} from "./sessions.ts";

test("a new session starts empty with its own thread", () => {
  const first = createSession();
  const second = createSession();
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.threadId, second.threadId);
  assert.equal(first.messages.length, 0);
  assert.equal(first.previousResponseId, "");
});

test("titles come from the first user turn", () => {
  assert.equal(
    deriveTitle([
      { id: "1", role: "assistant", content: "hello" },
      { id: "2", role: "user", content: "Refactor the parser\nsecond line" },
    ]),
    "Refactor the parser",
  );
  assert.equal(deriveTitle([]), "New session");
  assert.equal(deriveTitle([{ id: "1", role: "user", content: "  " }]), "New session");
});

test("long titles are truncated", () => {
  const title = deriveTitle([{ id: "1", role: "user", content: "a".repeat(90) }]);
  assert.equal(title.length, 48);
  assert.ok(title.endsWith("…"));
});

test("sessions are upserted, renamed, and removed by id", () => {
  const first = createSession();
  const second = createSession();
  let sessions = upsertSession(upsertSession([], first), second);
  assert.deepEqual(
    sessions.map((session) => session.id),
    [second.id, first.id],
  );

  sessions = upsertSession(sessions, { ...first, previousResponseId: "resp_1" });
  assert.equal(sessions.length, 2);
  assert.equal(
    sessions.find((session) => session.id === first.id)?.previousResponseId,
    "resp_1",
  );

  sessions = renameSession(sessions, first.id, "  Parser work  ");
  assert.equal(sessions.find((session) => session.id === first.id)?.title, "Parser work");
  sessions = renameSession(sessions, first.id, "   ");
  assert.equal(sessions.find((session) => session.id === first.id)?.title, "New session");

  sessions = removeSession(sessions, second.id);
  assert.deepEqual(
    sessions.map((session) => session.id),
    [first.id],
  );
});

test("stored sessions survive a round trip", () => {
  const session = {
    ...createSession(1),
    title: "Parser work",
    previousResponseId: "resp_1",
    messages: [{ id: "m1", role: "user" as const, content: "hi" }],
  };
  assert.deepEqual(parseSessions(serializeSessions([session])), [session]);
});

test("corrupt storage never breaks the session list", () => {
  assert.deepEqual(parseSessions(null), []);
  assert.deepEqual(parseSessions("not json"), []);
  assert.deepEqual(parseSessions('{"id":"a"}'), []);
  assert.deepEqual(parseSessions('[{"id":"a"}]'), []);

  const recovered = parseSessions(
    '[{"id":"a","threadId":"t","messages":[{"id":"m","role":"user","content":"hi"},{"role":"bogus"}]}]',
  );
  assert.equal(recovered.length, 1);
  assert.deepEqual(recovered[0].messages, [
    { id: "m", role: "user", content: "hi" },
  ]);
  assert.equal(recovered[0].title, "hi");
  assert.equal(recovered[0].previousResponseId, "");
});
