"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { HttpAgent, type Message } from "@ag-ui/client";
import Link from "next/link";
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

export default function Home() {
  const [connection, setConnection] = useState(emptyConnection);
  const [messages, setMessages] = useState<Message[]>([]);
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [profiles, setProfiles] = useState<ProfileOption[]>([]);
  const agentRef = useRef<HttpAgent | null>(null);

  if (agentRef.current === null) {
    agentRef.current = new HttpAgent({
      url: "/api/agent",
      threadId: crypto.randomUUID(),
      initialMessages: [],
      initialState: {},
    });
  }

  useEffect(() => {
    const agent = agentRef.current;
    if (!agent) return;
    return agent.subscribe({
      onMessagesChanged: ({ messages: nextMessages }) => {
        setMessages(nextMessages.map((message) => ({ ...message })) as Message[]);
      },
    }).unsubscribe;
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/profiles", { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : { profiles: [] }))
      .then((payload) => setProfiles(payload.profiles ?? []))
      // No profiles configured simply means the runtime default is used.
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  const visibleMessages = useMemo(
    () =>
      messages.filter(
        (message) =>
          (message.role === "user" || message.role === "assistant") &&
          messageText(message),
      ),
    [messages],
  );

  async function submit(event: FormEvent) {
    event.preventDefault();
    const value = prompt.trim();
    const agent = agentRef.current;
    if (!value || !agent || isRunning) return;

    setPrompt("");
    setError("");
    setIsRunning(true);
    agent.addMessage({
      id: crypto.randomUUID(),
      role: "user",
      content: value,
    });

    try {
      await agent.runAgent({
        forwardedProps: { connection },
      });
    } catch (runError) {
      setError(
        runError instanceof Error ? runError.message : "Agent request failed",
      );
    } finally {
      setIsRunning(false);
    }
  }

  function clearConversation() {
    const agent = agentRef.current;
    agent?.abortRun();
    if (agent) {
      agent.threadId = crypto.randomUUID();
      agent.setMessages([]);
      agent.setState({});
    }
    setMessages([]);
    setError("");
  }

  function updateConnection<K extends keyof Connection>(
    key: K,
    value: Connection[K],
  ) {
    setConnection((current) => ({ ...current, [key]: value }));
  }

  return (
    <main className={styles.shell}>
      <aside className={styles.settings}>
        <div>
          <p className={styles.eyebrow}>DigiBuddy</p>
          <h1>Codex Hosted Agent</h1>
          <p className={styles.subtitle}>
            AG-UI console for a Microsoft Foundry hosted coding runtime.
          </p>
        </div>

        <div className={styles.formGrid}>
          {profiles.length > 0 && (
            <label>
              Agent profile
              <select
                value={connection.profile}
                onChange={(event) =>
                  updateConnection("profile", event.target.value)
                }
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
              onChange={(event) =>
                updateConnection("endpoint", event.target.value)
              }
              placeholder="Server default or https://…/responses"
            />
          </label>
          <label>
            Endpoint key
            <input
              type="password"
              value={connection.apiKey}
              onChange={(event) =>
                updateConnection("apiKey", event.target.value)
              }
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
              onChange={(event) =>
                updateConnection("model", event.target.value)
              }
              placeholder="Server default"
            />
          </label>
          <label>
            Hosted Agent name
            <input
              value={connection.agentName}
              onChange={(event) =>
                updateConnection("agentName", event.target.value)
              }
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
        </div>

        <p className={styles.securityNote}>
          Keys stay in memory and pass only through the server-side proxy. Leave
          fields blank to use container environment settings.{" "}
          <Link href="/admin">Administer the runtime</Link>
        </p>
      </aside>

      <section className={styles.chat}>
        <header className={styles.chatHeader}>
          <div>
            <span className={styles.statusDot} />
            Responses protocol · AG-UI stream
          </div>
          <button type="button" onClick={clearConversation}>
            New session
          </button>
        </header>

        <div className={styles.messages} aria-live="polite">
          {visibleMessages.length === 0 ? (
            <div className={styles.emptyState}>
              <span>⌁</span>
              <h2>Give Codex a software task</h2>
              <p>
                Analyze a repository, implement a focused change, or run
                validation in the isolated Foundry workspace.
              </p>
            </div>
          ) : (
            visibleMessages.map((message) => (
              <article
                className={
                  message.role === "user"
                    ? styles.userMessage
                    : styles.agentMessage
                }
                key={message.id}
              >
                <small>{message.role === "user" ? "You" : "Codex"}</small>
                <p>{messageText(message)}</p>
              </article>
            ))
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
    </main>
  );
}
