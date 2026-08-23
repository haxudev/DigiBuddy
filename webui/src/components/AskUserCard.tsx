"use client";

import { useState } from "react";
import type { AskUserRequest } from "@/lib/ask-user";
import { formatAskUserAnswer } from "@/lib/ask-user";
import styles from "./ask-user-card.module.css";

type Props = {
  request: AskUserRequest;
  disabled: boolean;
  onAnswer: (answer: string) => void;
};

const OTHER = "__other__";

export default function AskUserCard({ request, disabled, onAnswer }: Props) {
  const [selected, setSelected] = useState<string[]>([]);
  const [freeText, setFreeText] = useState("");
  const [submitted, setSubmitted] = useState("");

  const usesOther = selected.includes(OTHER);
  const values =
    request.type === "text"
      ? [freeText]
      : selected
          .filter((value) => value !== OTHER)
          .concat(usesOther ? [freeText] : []);
  const answer = formatAskUserAnswer(request, values);

  function toggle(value: string) {
    setSelected((current) => {
      if (request.type === "single") {
        return current.includes(value) ? [] : [value];
      }
      return current.includes(value)
        ? current.filter((item) => item !== value)
        : [...current, value];
    });
  }

  function submit() {
    if (!answer || disabled) return;
    setSubmitted(answer);
    onAnswer(answer);
  }

  if (submitted) {
    return (
      <div className={`${styles.card} ${styles.answered}`}>
        <p className={styles.question}>{request.question}</p>
        <p className={styles.submitted}>{submitted}</p>
      </div>
    );
  }

  return (
    <div className={styles.card}>
      <p className={styles.eyebrow}>
        {request.type === "multi"
          ? "Select all that apply"
          : request.type === "single"
            ? "Select one"
            : "Your answer"}
      </p>
      <p className={styles.question}>{request.question}</p>

      {request.type !== "text" && (
        <div className={styles.options} role="group" aria-label={request.question}>
          {request.options.map((option) => (
            <button
              key={option.value}
              type="button"
              disabled={disabled}
              aria-pressed={selected.includes(option.value)}
              className={
                selected.includes(option.value)
                  ? `${styles.option} ${styles.optionSelected}`
                  : styles.option
              }
              onClick={() => toggle(option.value)}
            >
              <span className={styles.optionLabel}>{option.label}</span>
              {option.description && (
                <span className={styles.optionDescription}>{option.description}</span>
              )}
            </button>
          ))}
          {request.allowOther && (
            <button
              type="button"
              disabled={disabled}
              aria-pressed={usesOther}
              className={
                usesOther ? `${styles.option} ${styles.optionSelected}` : styles.option
              }
              onClick={() => toggle(OTHER)}
            >
              <span className={styles.optionLabel}>Something else</span>
            </button>
          )}
        </div>
      )}

      {(request.type === "text" || usesOther) && (
        <textarea
          className={styles.input}
          value={freeText}
          disabled={disabled}
          rows={3}
          placeholder={request.placeholder || "Type your answer…"}
          onChange={(event) => setFreeText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
        />
      )}

      <div className={styles.actions}>
        <button type="button" disabled={disabled || !answer} onClick={submit}>
          Send answer
        </button>
      </div>
    </div>
  );
}
