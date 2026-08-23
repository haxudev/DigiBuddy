"use client";

import { useState } from "react";
import type { ActivityEntry } from "@/lib/activity";
import styles from "./activity-trail.module.css";

const ICONS: Record<ActivityEntry["kind"], string> = {
  thinking: "◈",
  tool: "⚙",
  error: "!",
};

const LABELS: Record<ActivityEntry["kind"], string> = {
  thinking: "Thinking",
  tool: "Tool",
  error: "Error",
};

function Row({ entry }: { entry: ActivityEntry }) {
  const [open, setOpen] = useState(false);
  const expandable = entry.detail.trim().length > 0;

  return (
    <li className={styles.row} data-kind={entry.kind} data-status={entry.status}>
      <button
        type="button"
        className={styles.summary}
        onClick={() => setOpen((current) => !current)}
        aria-expanded={expandable ? open : undefined}
        disabled={!expandable}
      >
        <span className={styles.icon} aria-hidden="true">
          {ICONS[entry.kind]}
        </span>
        <span className={styles.label}>{LABELS[entry.kind]}</span>
        <span className={styles.title}>{entry.title}</span>
        {expandable && (
          <span className={styles.chevron} aria-hidden="true">
            {open ? "▾" : "▸"}
          </span>
        )}
      </button>
      {expandable && open && <pre className={styles.detail}>{entry.detail}</pre>}
    </li>
  );
}

/**
 * The collapsed record of what the agent thought and did for one turn. Every
 * row is a single line until the reader opens it, so a long run of tool calls
 * never buries the answer.
 */
export default function ActivityTrail({
  entries,
  running,
}: {
  entries: ActivityEntry[];
  running: boolean;
}) {
  const [collapsed, setCollapsed] = useState(false);
  if (!entries.length) return null;

  return (
    <section className={styles.trail} aria-label="Agent activity">
      <button
        type="button"
        className={styles.toggle}
        onClick={() => setCollapsed((current) => !current)}
        aria-expanded={!collapsed}
      >
        <span className={styles.chevron} aria-hidden="true">
          {collapsed ? "▸" : "▾"}
        </span>
        {running ? "Working" : "Activity"}
        <span className={styles.count}>{entries.length}</span>
      </button>
      {!collapsed && (
        <ul className={styles.rows}>
          {entries.map((entry) => (
            <Row key={entry.id} entry={entry} />
          ))}
        </ul>
      )}
    </section>
  );
}
