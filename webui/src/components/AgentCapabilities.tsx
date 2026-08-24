"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { ProfileCapabilities } from "@/lib/profile-capabilities";
import styles from "./agent-capabilities.module.css";

type Props = {
  profiles: ProfileCapabilities[];
  selected: string;
  /**
   * The runtime has reported which agent this conversation runs. Codex fixes a
   * thread's base instructions when the thread starts, so from here the choice
   * belongs to the conversation and a new one is the only way to change it.
   */
  bound: boolean;
  /** A turn is in flight, so the server may be binding right now. */
  running: boolean;
  onSelect: (name: string) => void;
  onStartNewSession: (name: string) => void;
};

function Group({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <section className={styles.group}>
      <h4>
        {title}
        <span className={styles.count}>{items.length}</span>
      </h4>
      <ul className={styles.chips}>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </section>
  );
}

/**
 * One quiet control in the header that answers "who am I talking to, and what
 * can it reach?". Collapsed it is just the agent's name; opened it lists the
 * agents on offer and the skills, tools and MCP servers each one carries.
 *
 * Once the conversation is bound it stops being a picker and becomes a
 * statement, because picking would otherwise appear to work while the runtime
 * kept the original agent.
 */
export default function AgentCapabilities({
  profiles,
  selected,
  bound,
  running,
  onSelect,
  onStartNewSession,
}: Props) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const active = profiles.find((profile) => profile.name === selected);
  // While a first turn is in flight the server may already have bound the
  // conversation, so offering a change would be a promise this cannot keep.
  const locked = bound || running;

  function choose(name: string) {
    if (name === selected) {
      setOpen(false);
      return;
    }
    if (locked) {
      onStartNewSession(name);
    } else {
      onSelect(name);
    }
    setOpen(false);
  }

  return (
    <div className={styles.root} ref={containerRef}>
      <button
        type="button"
        className={styles.trigger}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <span className={styles.dot} aria-hidden="true" />
        {active?.display_name ?? "DigiBuddy"}
        <span className={styles.chevron} aria-hidden="true">
          ▾
        </span>
      </button>

      {open && (
        <div className={styles.popover} role="dialog" aria-label="Agent capabilities">
          {locked && (
            <p className={styles.hint}>
              {bound
                ? `This conversation runs ${active?.display_name ?? "the runtime default"}. Choosing another agent starts a new conversation.`
                : "Waiting for the agent to confirm this conversation."}
            </p>
          )}

          {profiles.length > 0 && (
            <ul className={styles.profiles}>
              <li>
                <button
                  type="button"
                  className={selected ? styles.profile : `${styles.profile} ${styles.profileActive}`}
                  onClick={() => choose("")}
                >
                  <span className={styles.profileName}>DigiBuddy</span>
                  <span className={styles.profileNote}>Runtime default</span>
                </button>
              </li>
              {profiles.map((profile) => (
                <li key={profile.name}>
                  <button
                    type="button"
                    className={
                      profile.name === selected
                        ? `${styles.profile} ${styles.profileActive}`
                        : styles.profile
                    }
                    onClick={() => choose(profile.name)}
                  >
                    <span className={styles.profileName}>
                      {profile.display_name}
                      {locked && profile.name !== selected && (
                        <span className={styles.profileNote}> — in a new conversation</span>
                      )}
                    </span>
                    {profile.description && (
                      <span className={styles.profileNote}>{profile.description}</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}

          {active ? (
            <div className={styles.body}>
              <Group title="Skills" items={active.skills} />
              <Group title="Tools" items={active.tools} />
              <Group title="MCP servers" items={active.mcp_servers} />
              {!active.skills.length &&
                !active.tools.length &&
                !active.mcp_servers.length && (
                  <p className={styles.hint}>No capabilities published for this profile.</p>
                )}
            </div>
          ) : (
            <p className={styles.hint}>
              The runtime chooses the model, skills and tools for this conversation.
            </p>
          )}

          <footer className={styles.footer}>
            <Link href="/admin">Administer the runtime</Link>
          </footer>
        </div>
      )}
    </div>
  );
}
