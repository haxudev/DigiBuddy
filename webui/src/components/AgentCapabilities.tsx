"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { ProfileCapabilities } from "@/lib/profile-capabilities";
import styles from "./agent-capabilities.module.css";

type Props = {
  profiles: ProfileCapabilities[];
  selected: string;
  onSelect: (name: string) => void;
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
 * can it reach?". Collapsed it is just the profile name; opened it lists the
 * personas on offer and the skills, tools and MCP servers each one carries.
 */
export default function AgentCapabilities({ profiles, selected, onSelect }: Props) {
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
          {profiles.length > 0 && (
            <ul className={styles.profiles}>
              <li>
                <button
                  type="button"
                  className={selected ? styles.profile : `${styles.profile} ${styles.profileActive}`}
                  onClick={() => onSelect("")}
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
                    onClick={() => onSelect(profile.name)}
                  >
                    <span className={styles.profileName}>{profile.display_name}</span>
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
