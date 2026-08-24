import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createSession,
  deriveTitle,
  isBound,
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
    ...createSession("", 1),
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

test("a session carries both the requested and the bound agent", () => {
  const session = createSession("marketing", 1000);

  assert.equal(session.requestedProfile, "marketing");
  assert.equal(session.boundProfile, "");
  assert.equal(isBound(session), false);
  assert.equal(isBound({ ...session, boundProfile: "marketing" }), true);
});

test("a stored profile survives a reload", () => {
  const session = {
    ...createSession("marketing", 1000),
    boundProfile: "marketing",
  };

  const [restored] = parseSessions(serializeSessions([session]));

  assert.equal(restored.requestedProfile, "marketing");
  assert.equal(restored.boundProfile, "marketing");
});

test("a session stored before bindings existed does not claim an agent", () => {
  const legacy = JSON.stringify([
    {
      id: "s1",
      title: "Old",
      threadId: "t1",
      previousResponseId: "resp-1",
      messages: [],
      createdAt: 1,
      updatedAt: 2,
    },
  ]);

  const [restored] = parseSessions(legacy);

  assert.equal(restored.requestedProfile, "");
  assert.equal(restored.boundProfile, "");
  assert.equal(isBound(restored), false);
});

test("a non-string profile in storage is discarded, not trusted", () => {
  const hostile = JSON.stringify([
    {
      id: "s1",
      title: "T",
      threadId: "t1",
      requestedProfile: { toString: "nope" },
      boundProfile: 42,
      messages: [],
    },
  ]);

  const [restored] = parseSessions(hostile);

  assert.equal(restored.requestedProfile, "");
  assert.equal(restored.boundProfile, "");
});

test("a session never stores something that cannot be cloned", () => {
  // Regression: `createNewSession` was passed to a button as `onClick={onCreate}`,
  // so React handed it a PointerEvent as the profile name. The session then held
  // an unclonable object, and the failure surfaced one turn later inside
  // structuredClone rather than at the click that caused it.
  const eventLike = { type: "pointerdown", isTrusted: true } as unknown as string;

  const session = createSession(eventLike);

  assert.equal(session.requestedProfile, "");
  assert.doesNotThrow(() => structuredClone(session));
});

test("a profile name still survives when it is actually a name", () => {
  assert.equal(createSession("marketing").requestedProfile, "marketing");
});
