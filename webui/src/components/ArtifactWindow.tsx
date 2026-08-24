"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Artifact } from "@/lib/artifacts";
import { isImageArtifact } from "@/lib/artifacts";
import Markdown from "./Markdown";
import styles from "./artifact-panel.module.css";

type Props = {
  artifacts: Artifact[];
  onClose: () => void;
};

function kindLabel(artifact: Artifact): string {
  if (artifact.kind === "link") return artifact.language.toUpperCase() || "FILE";
  return artifact.language.toUpperCase();
}

/**
 * Deliverables live in a floating window rather than a permanent column: the
 * conversation keeps the full width until the reader opens something, and the
 * window can be dragged aside or expanded to fill the viewport for review.
 */
export default function ArtifactWindow({ artifacts, onClose }: Props) {
  const [selectedId, setSelectedId] = useState("");
  const [showSource, setShowSource] = useState(false);
  const [maximised, setMaximised] = useState(false);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const startDrag = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      // Dragging a maximised window would fight the full-viewport layout, and
      // the title bar also carries buttons that must stay clickable.
      if (maximised) return;
      if ((event.target as HTMLElement).closest("button")) return;
      dragRef.current = {
        pointerId: event.pointerId,
        x: event.clientX - offset.x,
        y: event.clientY - offset.y,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [maximised, offset],
  );

  const onDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setOffset({ x: event.clientX - drag.x, y: event.clientY - drag.y });
  }, []);

  const endDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  }, []);

  // Follow the newest deliverable unless the user pinned an older one.
  const selected =
    artifacts.find((artifact) => artifact.id === selectedId) ??
    artifacts[artifacts.length - 1];

  return (
    <aside
      className={styles.panel}
      data-maximised={maximised ? "true" : "false"}
      style={
        maximised
          ? undefined
          : { transform: `translate(${offset.x}px, ${offset.y}px)` }
      }
      aria-label="Deliverables"
    >
      <div
        className={styles.header}
        onPointerDown={startDrag}
        onPointerMove={onDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <span className={styles.grip} aria-hidden="true">
          ⠿
        </span>
        <h2>Deliverables</h2>
        <span className={styles.count}>{artifacts.length}</span>
        <span className={styles.headerSpacer} />
        <button
          type="button"
          className={styles.headerButton}
          onClick={() => setMaximised((value) => !value)}
          aria-label={maximised ? "Restore window" : "Maximise window"}
          title={maximised ? "Restore" : "Full screen"}
        >
          {maximised ? "❐" : "⛶"}
        </button>
        <button
          type="button"
          className={styles.headerButton}
          onClick={onClose}
          aria-label="Close deliverables"
          title="Close"
        >
          ×
        </button>
      </div>

      {artifacts.length === 0 ? (
        <div className={styles.empty}>
          <p>Nothing produced yet.</p>
          <p className={styles.hint}>
            Files, documents, and generated pages appear here for preview.
          </p>
        </div>
      ) : (
        <>
          <ul className={styles.list}>
            {artifacts.map((artifact) => (
              <li key={artifact.id}>
                <button
                  type="button"
                  className={
                    artifact.id === selected?.id
                      ? `${styles.item} ${styles.itemActive}`
                      : styles.item
                  }
                  onClick={() => {
                    setSelectedId(artifact.id);
                    setShowSource(false);
                  }}
                >
                  <span className={styles.itemKind}>{kindLabel(artifact)}</span>
                  <span className={styles.itemTitle}>{artifact.title}</span>
                </button>
              </li>
            ))}
          </ul>

          {selected && (
            <div className={styles.preview}>
              <div className={styles.previewHeader}>
                <span>{selected.title}</span>
                {selected.kind === "link" ? (
                  <a href={selected.url} target="_blank" rel="noreferrer">
                    Open
                  </a>
                ) : (
                  selected.kind !== "code" && (
                    <button type="button" onClick={() => setShowSource((value) => !value)}>
                      {showSource ? "Preview" : "Source"}
                    </button>
                  )
                )}
              </div>

              <div className={styles.previewBody}>
                {selected.kind === "link" ? (
                  isImageArtifact(selected) ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={selected.url} alt={selected.title} className={styles.image} />
                  ) : (
                    <div className={styles.download}>
                      <p>{selected.title}</p>
                      <a href={selected.url} target="_blank" rel="noreferrer">
                        Download
                      </a>
                    </div>
                  )
                ) : selected.kind === "html" && !showSource ? (
                  <iframe
                    className={styles.frame}
                    title={selected.title}
                    sandbox=""
                    srcDoc={selected.content}
                  />
                ) : selected.kind === "markdown" && !showSource ? (
                  <div className={styles.document}>
                    <Markdown>{selected.content}</Markdown>
                  </div>
                ) : (
                  <pre className={styles.source}>
                    <code>{selected.content}</code>
                  </pre>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </aside>
  );
}
