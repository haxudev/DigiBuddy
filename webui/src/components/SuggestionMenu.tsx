"use client";

import { useEffect, useRef } from "react";
import styles from "./suggestion-menu.module.css";

export type SuggestionItem = {
  /** Stable across refilters, so React keeps the row it already rendered. */
  key: string;
  title: string;
  description?: string;
  /** The token that invokes it, shown on the right: `/pptx`, `@marketing`. */
  token?: string;
  /** One glyph. Falls back to the first letter of the title. */
  icon?: string;
  /** Already in force for this conversation or this message. */
  current?: boolean;
};

/** Whether the list behind the menu could be loaded at all. */
export type SuggestionStatus = "loading" | "ready" | "unavailable";

export type SuggestionMenuProps = {
  id: string;
  heading: string;
  /** What a screen reader calls the list. */
  label: string;
  items: SuggestionItem[];
  activeIndex: number;
  status: SuggestionStatus;
  /** Shown above the list, for a rule the reader has to know before choosing. */
  note?: string;
  /** Shown when the list loaded and matched nothing. */
  emptyMessage: string;
  /** Shown when the list could not be loaded. */
  unavailableMessage: string;
  onHighlight: (index: number) => void;
  onChoose: (index: number) => void;
};

export function suggestionOptionId(menuId: string, index: number): string {
  return `${menuId}-option-${index}`;
}

/**
 * The list the composer offers while `@` or `/` is being typed.
 *
 * The caret never leaves the textarea, so this is not a focus trap: the
 * composer owns the highlight and moves it, and the textarea points at the
 * highlighted row with `aria-activedescendant`. That is what makes the menu
 * feel like part of the text being typed rather than a dialogue to escape
 * from -- and it is why the highlight has to be drawn, not merely implied by
 * `:focus`.
 */
export default function SuggestionMenu({
  id,
  heading,
  label,
  items,
  activeIndex,
  status,
  note,
  emptyMessage,
  unavailableMessage,
  onHighlight,
  onChoose,
}: SuggestionMenuProps) {
  const listRef = useRef<HTMLUListElement | null>(null);

  // A highlight that has scrolled out of view is not a highlight.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const option = list.querySelector<HTMLElement>('[data-active="true"]');
    option?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, items]);

  const empty = status === "ready" && items.length === 0;

  return (
    <div className={styles.menu}>
      <div className={styles.header}>
        <span className={styles.heading}>{heading}</span>
        {status === "ready" && items.length > 0 && (
          <span className={styles.count}>{items.length}</span>
        )}
      </div>

      {note && <p className={styles.note}>{note}</p>}

      {status === "loading" && (
        <p className={styles.state} role="status">
          <span className={styles.spinner} aria-hidden="true" />
          Loading…
        </p>
      )}

      {status === "unavailable" && (
        <p className={styles.state} data-tone="warning" role="status">
          <span className={styles.stateIcon} aria-hidden="true">
            !
          </span>
          {unavailableMessage}
        </p>
      )}

      {empty && (
        <p className={styles.state} role="status">
          {emptyMessage}
        </p>
      )}

      {items.length > 0 && (
        <ul className={styles.list} id={id} role="listbox" aria-label={label} ref={listRef}>
          {items.map((item, index) => {
            const active = index === activeIndex;
            return (
              <li
                key={item.key}
                id={suggestionOptionId(id, index)}
                className={styles.option}
                role="option"
                aria-selected={active}
                data-active={active}
                onMouseEnter={() => onHighlight(index)}
                // The caret must not leave the textarea, and a plain click
                // would take it. Choosing on mousedown keeps the composer in
                // control of the selection and of the focus.
                onMouseDown={(event) => {
                  event.preventDefault();
                  onChoose(index);
                }}
              >
                <span className={styles.icon} aria-hidden="true">
                  {item.icon || item.title.charAt(0).toUpperCase()}
                </span>
                <span className={styles.body}>
                  <span className={styles.title}>
                    {item.title}
                    {item.current && <span className={styles.current}>in use</span>}
                  </span>
                  {item.description && (
                    <span className={styles.description}>{item.description}</span>
                  )}
                </span>
                {item.token && <span className={styles.token}>{item.token}</span>}
              </li>
            );
          })}
        </ul>
      )}

      {items.length > 0 && (
        <p className={styles.hints} aria-hidden="true">
          <kbd>↑</kbd>
          <kbd>↓</kbd>
          <span>move</span>
          <kbd>↵</kbd>
          <span>choose</span>
          <kbd>esc</kbd>
          <span>dismiss</span>
        </p>
      )}
    </div>
  );
}
