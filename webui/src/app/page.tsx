"use client";

import {
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { HttpAgent, type Message } from "@ag-ui/client";
import Link from "next/link";
import ArtifactPanel from "@/components/ArtifactPanel";
import AskUserCard from "@/components/AskUserCard";
import Markdown from "@/components/Markdown";
import SessionSidebar from "@/components/SessionSidebar";
import { extractArtifacts, type Artifact } from "@/lib/artifacts";
import { splitMessage } from "@/lib/ask-user";
import {
  getServerSessions,
  getSession,
  getSessions,
  replaceSessions,
  subscribeSessions,
  updateSession,
} from "@/lib/session-store";
import {
  StoredMessage,
  createSession,
  deriveTitle,
  removeSession,
  renameSession,
  upsertSession,
} from "@/lib/sessions";
import styles from "./page.module.css";

type Connection = {
  endpoint: string;
  apiKey: string;
  authMode: "api-key" | "bearer";
  model: string;
  agentName: string;
  agentVersion: string;
  profile: string;
};

type ProfileOption = {
  name: string;
  display_name: string;
  description: string;
};

const emptyConnection: Connection = {
  endpoint: "",
  apiKey: "",
  authMode: "api-key",
  model: "",
  agentName: "",
  agentVersion: "1",
  profile: "",
};

function messageText(message: Message): string {
  if (typeof message.content === "string") {
    return message.content;
  }
  if (Array.isArray(message.content)) {
    return message.content
      .map((item) =>
        typeof item === "object" && item && "text" in item
          ? String(item.text)
          : "",
      )
      .join("");
  }
  return "";
}

function toStoredMessages(messages: Message[]): StoredMessage[] {
  return messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({
      id: message.id,
      role: message.role as StoredMessage["role"],
      content: messageText(message),
    }))
    .filter((message) => message.content.trim());
}

export default function Home() {
  const [connection, setConnection] = useState(emptyConnection);
  const [selectedId, setSelectedId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [profiles, setProfiles] = useState<ProfileOption[]>([]);
  const agentRef = useRef<HttpAgent | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  // Sessions live in browser storage: the Responses API keeps each transcript
  // server side behind a response id, but the console needs its own history.
  const sessions = useSyncExternalStore(
    subscribeSessions,
    getSessions,
    getServerSessions,
  );

  const activeSession =
    sessions.find((session) => session.id === selectedId) ?? sessions[0];
  const activeId = activeSession?.id ?? "";

  // Each session owns an agent so switching never mixes transcripts or reuses
  // another session's previous response id.
  useEffect(() => {
    if (!activeId) return;
    const session = getSession(activeId);
    if (!session) return;

    const agent = new HttpAgent({
      url: "/api/agent",
      threadId: session.threadId,
      initialMessages: session.messages.map((message) => ({ ...message })),
      initialState: { previousResponseId: session.previousResponseId },
    });
    agentRef.current = agent;

    const subscription = agent.subscribe({
      onMessagesChanged: ({ messages: nextMessages }) => {
        const stored = toStoredMessages(nextMessages as Message[]);
        updateSession(activeId, (item) => ({
          ...item,
          messages: stored,
          title: item.title === "New session" ? deriveTitle(stored) : item.title,
          updatedAt: Date.now(),
        }));
      },
      onStateChanged: ({ state }) => {
        const responseId =
          state && typeof state === "object" && "previousResponseId" in state
            ? String((state as Record<string, unknown>).previousResponseId ?? "")
            : "";
        if (!responseId) return;
        updateSession(activeId, (item) => ({
          ...item,
          previousResponseId: responseId,
        }));
      },
    });

    return () => {
      agent.abortRun();
      subscription.unsubscribe();
      if (agentRef.current === agent) agentRef.current = null;
    };
  }, [activeId]);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/profiles", { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : { profiles: [] }))
      .then((payload) => setProfiles(payload.profiles ?? []))
      // No profiles configured simply means the runtime default is used.
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  const messages = useMemo(() => activeSession?.messages ?? [], [activeSession]);


  useEffect(() => {
    const transcript = transcriptRef.current;
    if (transcript) transcript.scrollTop = transcript.scrollHeight;
  }, [messages]);

  const artifacts = useMemo<Artifact[]>(
    () =>
      messages
        .filter((message) => message.role === "assistant")
        .flatMap((message) => extractArtifacts(message.content, message.id)),
    [messages],
  );

  const send = useCallback(
    async (value: string) => {
      const agent = agentRef.current;
      const text = value.trim();
      if (!text || !agent || isRunning) return;

      setError("");
      setIsRunning(true);
      agent.addMessage({ id: crypto.randomUUID(), role: "user", content: text });

      try {
        await agent.runAgent({ forwardedProps: { connection } });
      } catch (runError) {
        setError(
          runError instanceof Error ? runError.message : "Agent request failed",
        );
      } finally {
        setIsRunning(false);
      }
    },
    [connection, isRunning],
  );

  function submit(event: FormEvent) {
    event.preventDefault();
    const value = prompt;
    setPrompt("");
    void send(value);
  }

  function selectSession(sessionId: string) {
    setSelectedId(sessionId);
    setError("");
  }

  function createNewSession() {
    const session = createSession();
    replaceSessions(upsertSession(sessions, session));
    selectSession(session.id);
  }

  function deleteSession(sessionId: string) {
    const remaining = removeSession(sessions, sessionId);
    replaceSessions(remaining);
    if (sessionId === activeId) selectSession(remaining[0]?.id ?? "");
  }

  function updateConnection<K extends keyof Connection>(
    key: K,
    value: Connection[K],
  ) {
    setConnection((current) => ({ ...current, [key]: value }));
  }

  return (
    <main className={styles.shell}>
      <SessionSidebar
        sessions={sessions}
        activeId={activeId}
        onSelect={selectSession}
        onCreate={createNewSession}
        onRename={(sessionId, title) =>
          replaceSessions(renameSession(sessions, sessionId, title))
        }
        onDelete={deleteSession}
      >
        <div className={styles.formGrid}>
          {profiles.length > 0 && (
            <label>
              Agent profile
              <select
                value={connection.profile}
                onChange={(event) => updateConnection("profile", event.target.value)}
              >
                <option value="">Runtime default</option>
                {profiles.map((profile) => (
                  <option key={profile.name} value={profile.name}>
                    {profile.display_name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            Hosted Agent Responses endpoint
            <input
              type="url"
              value={connection.endpoint}
              onChange={(event) => updateConnection("endpoint", event.target.value)}
              placeholder="Server default or https://…/responses"
            />
          </label>
          <label>
            Endpoint key
            <input
              type="password"
              value={connection.apiKey}
              onChange={(event) => updateConnection("apiKey", event.target.value)}
              placeholder="Server default"
              autoComplete="off"
            />
          </label>
          <label>
            Authentication
            <select
              value={connection.authMode}
              onChange={(event) =>
                updateConnection(
                  "authMode",
                  event.target.value as Connection["authMode"],
                )
              }
            >
              <option value="api-key">API key</option>
              <option value="bearer">OAuth access token</option>
            </select>
          </label>
          <label>
            Codex model name
            <input
              value={connection.model}
              onChange={(event) => updateConnection("model", event.target.value)}
              placeholder="Server default"
            />
          </label>
          <label>
            Hosted Agent name
            <input
              value={connection.agentName}
              onChange={(event) => updateConnection("agentName", event.target.value)}
              placeholder="Direct endpoint if blank"
            />
          </label>
          <label>
            Agent version
            <input
              value={connection.agentVersion}
              onChange={(event) =>
                updateConnection("agentVersion", event.target.value)
              }
            />
          </label>
          <p className={styles.securityNote}>
            Keys stay in memory and pass only through the server-side proxy. Leave
            fields blank to use container environment settings.{" "}
            <Link href="/admin">Administer the runtime</Link>
          </p>
        </div>
      </SessionSidebar>

      <section className={styles.chat}>
        <header className={styles.chatHeader}>
          <div>
            <span className={styles.statusDot} />
            {activeSession?.title ?? "Codex Hosted Agent"}
          </div>
          <span className={styles.protocol}>Responses · AG-UI stream</span>
        </header>

        <div className={styles.messages} aria-live="polite" ref={transcriptRef}>
          {messages.length === 0 ? (
            <div className={styles.emptyState}>
              <span>⌁</span>
              <h2>Give Codex a software task</h2>
              <p>
                Analyze a repository, implement a focused change, or run validation
                in the isolated Foundry workspace.
              </p>
            </div>
          ) : (
            messages.map((message) =>
              message.role === "user" ? (
                <article className={styles.userMessage} key={message.id}>
                  <small>You</small>
                  <p>{message.content}</p>
                </article>
              ) : (
                <article className={styles.agentMessage} key={message.id}>
                  <small>Codex</small>
                  {splitMessage(message.content, message.id).map((segment, index) =>
                    segment.kind === "ask" ? (
                      <AskUserCard
                        key={segment.request.id}
                        request={segment.request}
                        disabled={isRunning}
                        onAnswer={(answer) => void send(answer)}
                      />
                    ) : (
                      <Markdown key={`${message.id}-md-${index}`}>
                        {segment.text}
                      </Markdown>
                    ),
                  )}
                </article>
              ),
            )
          )}
        </div>

        {error && <div className={styles.error}>{error}</div>}

        <form className={styles.composer} onSubmit={submit}>
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder="Describe the coding outcome you need…"
            rows={3}
          />
          <button disabled={!prompt.trim() || isRunning} type="submit">
            {isRunning ? "Running…" : "Run task"}
          </button>
        </form>
      </section>

      <ArtifactPanel artifacts={artifacts} />
    </main>
  );
}
