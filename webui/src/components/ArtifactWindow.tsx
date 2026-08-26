"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Artifact } from "@/lib/artifacts";
import { artifactPreviewKind } from "@/lib/artifacts";
import Markdown from "./Markdown";
import styles from "./artifact-panel.module.css";

type Props = {
  artifacts: Artifact[];
  onClose: () => void;
};

// A report carries its charting library inside it, because the sandbox it is
// rendered in has no network to fetch one from. ECharts alone is over a
// megabyte, so the old two-megabyte ceiling refused exactly the deliverables
// this preview exists for.
const MAX_TEXT_PREVIEW_BYTES = 8 * 1024 * 1024;

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
  const [remotePreview, setRemotePreview] = useState<{
    id: string;
    loading: boolean;
    content: string;
    error: string;
  } | null>(null);
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
  const previewKind = selected ? artifactPreviewKind(selected) : "download";
  const needsRemoteText =
    selected?.kind === "link" &&
    (previewKind === "html" ||
      previewKind === "markdown" ||
      previewKind === "text");
  const selectedArtifactId = selected?.id ?? "";
  const selectedArtifactUrl = selected?.url ?? "";
  const previewContent =
    selected?.kind === "link" ? remotePreview?.content ?? "" : selected?.content ?? "";
  const downloadUrl = selected?.managed
    ? `${selected.url}?download=1`
    : selected?.url ?? "";

  useEffect(() => {
    if (!selectedArtifactId || !needsRemoteText) return;
    const controller = new AbortController();
    fetch(selectedArtifactUrl, { cache: "force-cache", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Preview failed with HTTP ${response.status}.`);
        const declaredSize = Number(response.headers.get("content-length") || "0");
        if (declaredSize > MAX_TEXT_PREVIEW_BYTES) {
          throw new Error("This file is too large to preview.");
        }
        const content = await response.text();
        if (new Blob([content]).size > MAX_TEXT_PREVIEW_BYTES) {
          throw new Error("This file is too large to preview.");
        }
        setRemotePreview({
          id: selectedArtifactId,
          loading: false,
          content,
          error: "",
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setRemotePreview({
          id: selectedArtifactId,
          loading: false,
          content: "",
          error: error instanceof Error ? error.message : "Preview is unavailable.",
        });
      });
    return () => controller.abort();
  }, [needsRemoteText, selectedArtifactId, selectedArtifactUrl]);

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
          onClick={() => onClose()}
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
                <span className={styles.previewActions}>
                  {(previewKind === "html" || previewKind === "markdown") &&
                    (!needsRemoteText ||
                      (remotePreview?.id === selected.id &&
                        !remotePreview.loading &&
                        !remotePreview.error)) && (
                    <button type="button" onClick={() => setShowSource((value) => !value)}>
                      {showSource ? "Preview" : "Source"}
                    </button>
                    )}
                  {selected.kind === "link" && (
                    <a href={downloadUrl} target="_blank" rel="noreferrer">
                      Download
                    </a>
                  )}
                </span>
              </div>

              <div className={styles.previewBody}>
                {needsRemoteText &&
                (!remotePreview ||
                  remotePreview.id !== selected.id ||
                  remotePreview.loading) ? (
                  <div className={styles.download}>Loading preview…</div>
                ) : needsRemoteText && remotePreview?.error ? (
                  <div className={styles.download}>
                    <p>{remotePreview.error}</p>
                    <a href={downloadUrl} target="_blank" rel="noreferrer">
                      Download
                    </a>
                  </div>
                ) : previewKind === "image" ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={selected.url} alt={selected.title} className={styles.image} />
                ) : previewKind === "pdf" ? (
                  <iframe
                    className={styles.frame}
                    title={selected.title}
                    sandbox=""
                    src={selected.url}
                  />
                ) : previewKind === "html" && !showSource ? (
                  <iframe
                    className={styles.frame}
                    title={selected.title}
                    // A report is charts and tables, so the preview has to run
                    // the page's own scripts. `allow-scripts` without
                    // `allow-same-origin` keeps the document in an opaque
                    // origin: it can draw, and it can reach neither this app's
                    // cookies and storage nor its API. Granting both together
                    // would be the same as not sandboxing at all.
                    sandbox="allow-scripts"
                    srcDoc={previewContent}
                  />
                ) : previewKind === "markdown" && !showSource ? (
                  <div className={styles.document}>
                    <Markdown>{previewContent}</Markdown>
                  </div>
                ) : previewKind === "text" || showSource ? (
                  <pre className={styles.source}>
                    <code>{previewContent}</code>
                  </pre>
                ) : (
                  <div className={styles.download}>
                    <p>{selected.title}</p>
                    <a href={downloadUrl} target="_blank" rel="noreferrer">
                      Download
                    </a>
                  </div>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </aside>
  );
}
