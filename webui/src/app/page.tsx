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
import ActivityTrail from "@/components/ActivityTrail";
import AskUserCard from "@/components/AskUserCard";
import Markdown from "@/components/Markdown";
import SessionSidebar from "@/components/SessionSidebar";
import {
  ACTIVITY_EVENT_NAME,
  isActivityEvent,
  reduceActivity,
  settleActivity,
  type ActivityEntry,
} from "@/lib/activity";
import { REASONING_EFFORTS, type TurnAttachment } from "@/lib/agent-proxy";
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

const EFFORT_LABELS: Record<string, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
};

/** What the composer will accept, matching the formats Codex can open. */
const ATTACHMENT_ACCEPT =
  "image/*,.pdf,.ppt,.pptx,.doc,.docx,.xls,.xlsx,.csv,.txt,.md,.json";

function readAsDataUrl(file: File): Promise<TurnAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.onload = () =>
      resolve({
        filename: file.name,
        mimeType: file.type,
        data: String(reader.result ?? ""),
      });
    reader.readAsDataURL(file);
  });
}

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
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [attachments, setAttachments] = useState<TurnAttachment[]>([]);
  const [reasoningEffort, setReasoningEffort] = useState("");
  // On phones and tablets the sidebar and the deliverable panel slide over the
  // conversation instead of squeezing it.
  const [navOpen, setNavOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const agentRef = useRef<HttpAgent | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

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
      onCustomEvent: ({ event }) => {
        // Thinking and tool rows arrive out of band so they never enter the
        // transcript the console stores and mines for deliverables.
        if (event.name !== ACTIVITY_EVENT_NAME) return;
        if (!isActivityEvent(event.value)) return;
        const activityEvent = event.value;
        setActivity((current) => reduceActivity(current, activityEvent));
      },
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
  }, [messages, activity]);

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
      setActivity([]);
      setIsRunning(true);
      agent.addMessage({ id: crypto.randomUUID(), role: "user", content: text });

      // Files belong to the turn that sends them, so the tray empties as soon
      // as the request is on its way.
      const files = attachments;
      setAttachments([]);

      try {
        await agent.runAgent({
          forwardedProps: {
            connection,
            attachments: files,
            reasoningEffort,
          },
        });
      } catch (runError) {
        setError(
          runError instanceof Error ? runError.message : "Agent request failed",
        );
      } finally {
        setActivity(settleActivity);
        setIsRunning(false);
      }
    },
    [attachments, connection, isRunning, reasoningEffort],
  );

  async function addFiles(list: FileList | null) {
    const files = Array.from(list ?? []);
    if (!files.length) return;
    try {
      const read = await Promise.all(files.map(readAsDataUrl));
      setAttachments((current) => [...current, ...read]);
    } catch (readError) {
      setError(
        readError instanceof Error ? readError.message : "Could not read the file.",
      );
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const value = prompt;
    setPrompt("");
    void send(value);
  }

  function selectSession(sessionId: string) {
    setSelectedId(sessionId);
    setError("");
    setNavOpen(false);
    // Activity describes one run, so it never follows the reader to another
    // session.
    setActivity([]);
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
    <main
      className={styles.shell}
      data-nav={navOpen ? "open" : "closed"}
      data-panel={panelOpen ? "open" : "closed"}
    >
      <div className={styles.navSlot}>
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
      </div>

      <button
        type="button"
        className={styles.backdrop}
        aria-label="Close panel"
        onClick={() => {
          setNavOpen(false);
          setPanelOpen(false);
        }}
      />

      <section className={styles.chat}>
        <header className={styles.chatHeader}>
          <div>
            <button
              type="button"
              className={styles.drawerButton}
              onClick={() => setNavOpen(true)}
              aria-label="Show sessions"
            >
              ☰
            </button>
            <span className={styles.statusDot} />
            {activeSession?.title ?? "Codex Hosted Agent"}
          </div>
          <span className={styles.protocol}>Responses · AG-UI stream</span>
          <button
            type="button"
            className={styles.drawerButton}
            onClick={() => setPanelOpen(true)}
            aria-label="Show deliverables"
          >
            ▤ {artifacts.length || ""}
          </button>
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
          <ActivityTrail entries={activity} running={isRunning} />
        </div>

        {error && (
          <div className={styles.error} role="alert">
            <span className={styles.errorIcon} aria-hidden="true">
              !
            </span>
            <div>
              <strong>The agent could not finish this turn</strong>
              <p>{error}</p>
            </div>
            <button type="button" onClick={() => setError("")} aria-label="Dismiss">
              ×
            </button>
          </div>
        )}

        <form className={styles.composer} onSubmit={submit}>
          {attachments.length > 0 && (
            <ul className={styles.attachments}>
              {attachments.map((attachment, index) => (
                <li key={`${attachment.filename}-${index}`}>
                  <span>{attachment.filename}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${attachment.filename}`}
                    onClick={() =>
                      setAttachments((current) =>
                        current.filter((_, position) => position !== index),
                      )
                    }
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
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
          <div className={styles.composerControls}>
            <input
              ref={fileInputRef}
              className={styles.fileInput}
              type="file"
              multiple
              accept={ATTACHMENT_ACCEPT}
              onChange={(event) => {
                void addFiles(event.target.files);
                event.target.value = "";
              }}
            />
            <button
              type="button"
              className={styles.ghostButton}
              onClick={() => fileInputRef.current?.click()}
            >
              Attach files
            </button>
            <label className={styles.effort}>
              Thinking
              <select
                value={reasoningEffort}
                onChange={(event) => setReasoningEffort(event.target.value)}
              >
                <option value="">Default</option>
                {REASONING_EFFORTS.map((effort) => (
                  <option key={effort} value={effort}>
                    {EFFORT_LABELS[effort]}
                  </option>
                ))}
              </select>
            </label>
            <button disabled={!prompt.trim() || isRunning} type="submit">
              {isRunning ? "Running…" : "Run task"}
            </button>
          </div>
        </form>
      </section>

      <div className={styles.panelSlot}>
        <ArtifactPanel artifacts={artifacts} />
      </div>
    </main>
  );
}
