"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./copy-button.module.css";

type Props = {
  /** The text to place on the clipboard, already stripped of any metadata. */
  value: string;
  /** Names the button for screen readers, e.g. "Copy the agent's answer". */
  label: string;
};

/**
 * Put a message on the clipboard.
 *
 * `navigator.clipboard` is unavailable on insecure origins and in older
 * browsers, so a hidden textarea and `execCommand` stand behind it. Copying a
 * transcript is not worth failing over, but it is worth saying when it fails
 * rather than showing a button that quietly does nothing.
 */
async function copy(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Fall through to the legacy path: a denied permission prompt and a
    // missing API look the same from here, and both have the same answer.
  }
  try {
    const holder = document.createElement("textarea");
    holder.value = value;
    holder.setAttribute("readonly", "");
    holder.style.position = "fixed";
    holder.style.opacity = "0";
    document.body.appendChild(holder);
    holder.select();
    const copied = document.execCommand("copy");
    document.body.removeChild(holder);
    return copied;
  } catch {
    return false;
  }
}

/** How long the button stays in its "done" state before returning to rest. */
const FEEDBACK_MS = 2000;

export default function CopyButton({ value, label }: Props) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  async function onClick() {
    const copied = await copy(value);
    setState(copied ? "copied" : "failed");
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setState("idle"), FEEDBACK_MS);
  }

  return (
    <>
      <button
        type="button"
        className={styles.button}
        data-state={state}
        onClick={() => void onClick()}
        aria-label={label}
        title={label}
        // Nothing to copy is not an error worth a message; the control simply
        // has no work to do.
        disabled={!value.trim()}
      >
        <span aria-hidden="true">{state === "copied" ? "✓" : "⧉"}</span>
        <span className={styles.text}>
          {state === "copied" ? "Copied" : state === "failed" ? "Failed" : "Copy"}
        </span>
      </button>
      {/* Announced separately, because the button's own label must stay stable
          for anyone navigating by control name. */}
      <span className={styles.announcement} role="status" aria-live="polite">
        {state === "copied"
          ? "Copied to the clipboard."
          : state === "failed"
            ? "The clipboard is not available in this browser."
            : ""}
      </span>
    </>
  );
}
