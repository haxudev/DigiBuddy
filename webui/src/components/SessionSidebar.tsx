"use client";

import { useState } from "react";
import type { ChatSession } from "@/lib/sessions";
import styles from "./session-sidebar.module.css";

type Props = {
  sessions: ChatSession[];
  activeId: string;
  onSelect: (sessionId: string) => void;
  onCreate: () => void;
  onRename: (sessionId: string, title: string) => void;
  onDelete: (sessionId: string) => void;
};

export default function SessionSidebar({
  sessions,
  activeId,
  onSelect,
  onCreate,
  onRename,
  onDelete,
}: Props) {
  const [editingId, setEditingId] = useState("");
  const [draftTitle, setDraftTitle] = useState("");

  function commitRename() {
    if (editingId) onRename(editingId, draftTitle);
    setEditingId("");
    setDraftTitle("");
  }

  return (
    <aside className={styles.sidebar}>
      <div className={styles.brand}>
        <h1>DigiBuddy</h1>
      </div>

      <button
        type="button"
        className={styles.newSession}
        // Called with no arguments on purpose. Passing the handler by reference
        // hands React's event object to whatever the parent's first parameter
        // happens to be, and an event is not clonable, so it poisons any state
        // it reaches.
        onClick={() => onCreate()}
      >
        + New session
      </button>

      <ul className={styles.list}>
        {sessions.map((session) => (
          <li key={session.id}>
            {editingId === session.id ? (
              <input
                className={styles.rename}
                value={draftTitle}
                autoFocus
                onChange={(event) => setDraftTitle(event.target.value)}
                onBlur={commitRename}
                onKeyDown={(event) => {
                  if (event.key === "Enter") commitRename();
                  if (event.key === "Escape") setEditingId("");
                }}
              />
            ) : (
              <div
                className={
                  session.id === activeId
                    ? `${styles.item} ${styles.itemActive}`
                    : styles.item
                }
              >
                <button
                  type="button"
                  className={styles.itemButton}
                  onClick={() => onSelect(session.id)}
                  onDoubleClick={() => {
                    setEditingId(session.id);
                    setDraftTitle(session.title);
                  }}
                  title={session.title}
                >
                  <span className={styles.itemTitle}>{session.title}</span>
                  <span className={styles.itemMeta}>
                    {session.messages.length} messages
                  </span>
                </button>
                <button
                  type="button"
                  className={styles.itemDelete}
                  aria-label={`Delete ${session.title}`}
                  onClick={() => onDelete(session.id)}
                >
                  ×
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>

      <footer className={styles.poweredBy}>
        Powered by Codex on Microsoft Foundry Hosted Agent
      </footer>
    </aside>
  );
}
