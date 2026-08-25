"use client";

import { useEffect, useState } from "react";
import { liveSummary, type ActivityEntry } from "@/lib/activity";
import styles from "./activity-trail.module.css";

const ICONS: Record<ActivityEntry["kind"], string> = {
  thinking: "◈",
  tool: "⚙",
  error: "!",
};

/** Screen readers still need the kind the icon stands for. */
const LABELS: Record<ActivityEntry["kind"], string> = {
  thinking: "Reasoning step",
  tool: "Tool call",
  error: "Failure",
};

/** `m:ss`, because a wait long enough to need a clock is measured in minutes. */
export function formatElapsed(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * How long the current turn has been running.
 *
 * The clock stops when the run does, so the number a finished turn leaves
 * behind is how long it took rather than how long the tab has been open.
 */
function useElapsed(running: boolean, startedAt: number): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!running || !startedAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running, startedAt]);

  if (!startedAt) return 0;
  // A clock that has not ticked yet is behind the run that just started, and
  // "0:00" is the honest reading for a turn sent a moment ago.
  return Math.max(0, now - startedAt);
}

function Row({ entry, running }: { entry: ActivityEntry; running: boolean }) {
  const [open, setOpen] = useState(false);
  const expandable = entry.detail.trim().length > 0;
  // A thought still being written shows its newest line, so the row moves with
  // the model instead of freezing on the first sentence it produced.
  const live = running && entry.status === "running" && entry.kind === "thinking";
  const title = live ? liveSummary(entry.detail) : entry.title;

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
        <span className={styles.srOnly}>{LABELS[entry.kind]}</span>
        <span className={styles.title} data-live={live}>
          {title}
        </span>
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
 * The collapsed record of what the agent thought and did for one turn.
 *
 * It appears the moment a turn is sent, not the moment the first token comes
 * back. The gap between those two is a sandbox cold start and a coding agent
 * booting, and it is the part of the wait that most needs something to look
 * at: a console showing nothing there reads as a console that lost the
 * request. Every row stays a single line until the reader opens it, so a long
 * run of tool calls never buries the answer.
 */
export default function ActivityTrail({
  entries,
  running,
  startedAt = 0,
}: {
  entries: ActivityEntry[];
  running: boolean;
  /** When the turn was sent, so the wait is counted from the right moment. */
  startedAt?: number;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const elapsed = useElapsed(running, startedAt);
  if (!entries.length && !running) return null;

  const waiting = running && entries.length === 0;

  return (
    <section className={styles.trail} aria-label="Agent activity">
      <button
        type="button"
        className={styles.toggle}
        onClick={() => setCollapsed((current) => !current)}
        aria-expanded={!collapsed}
        data-running={running}
      >
        <span className={styles.chevron} aria-hidden="true">
          {collapsed ? "▸" : "▾"}
        </span>
        {running ? "Working" : "Activity"}
        {entries.length > 0 && (
          <span className={styles.count}>{entries.length}</span>
        )}
        {running && startedAt > 0 && (
          <span className={styles.elapsed}>{formatElapsed(elapsed)}</span>
        )}
      </button>

      {waiting && !collapsed && (
        <p className={styles.waiting} role="status">
          <span className={styles.dots} aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          Thinking about your request…
        </p>
      )}

      {!collapsed && entries.length > 0 && (
        <ul className={styles.rows}>
          {entries.map((entry) => (
            <Row key={entry.id} entry={entry} running={running} />
          ))}
        </ul>
      )}
    </section>
  );
}
