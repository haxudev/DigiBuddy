"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Artifact } from "@/lib/artifacts";
import { withScriptErrorReporter } from "@/lib/artifact-preview";
import { artifactPreviewKind } from "@/lib/artifacts";
import {
  clampPanelWidth,
  panelWidthFromPointer,
  readPanelWidthFromWindow,
  writePanelWidthToWindow,
} from "@/lib/deliverables-panel";
import Markdown from "./Markdown";
import styles from "./artifact-panel.module.css";

type Props = {
  artifacts: Artifact[];
  onClose: () => void;
  /** The width currently installed on the shell grid track. */
  width: number;
  /** Measures the tracks the transcript and docked column actually share. */
  getAvailableWidth: () => number | null;
  /** Told to the shell, which owns the grid track the panel sits in. */
  onWidthChange: (width: number) => void;
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
 * Deliverables live in a column of their own, level with the sessions sidebar
 * and the conversation: a generated file is read next to the answer that
 * produced it, not on top of it. The reader sizes the column by dragging its
 * left edge, and can expand it over the viewport for a full-page review.
 */
export default function ArtifactWindow({
  artifacts,
  onClose,
  width,
  getAvailableWidth,
  onWidthChange,
}: Props) {
  const [selectedId, setSelectedId] = useState("");
  const [showSource, setShowSource] = useState(false);
  const [maximised, setMaximised] = useState(false);
  const [remotePreview, setRemotePreview] = useState<{
    id: string;
    loading: boolean;
    content: string;
    error: string;
  } | null>(null);
  const resizeRef = useRef<number | null>(null);

  // The remembered width is read once the panel is on a client, because the
  // server has no storage to read it from and rendering two different widths
  // would be a hydration mismatch.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = readPanelWidthFromWindow(window);
    const available = getAvailableWidth();
    onWidthChange(available === null ? stored : clampPanelWidth(stored, available));
  }, [getAvailableWidth, onWidthChange]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const startResize = useCallback((event: React.PointerEvent<HTMLElement>) => {
    resizeRef.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);

  const onResize = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (resizeRef.current !== event.pointerId) return;
      const available = getAvailableWidth();
      if (available === null) return;
      const width = clampPanelWidth(
        panelWidthFromPointer(event.clientX, window.innerWidth),
        available,
      );
      onWidthChange(width);
    },
    [getAvailableWidth, onWidthChange],
  );

  const endResize = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (resizeRef.current !== event.pointerId) return;
      resizeRef.current = null;
      event.currentTarget.releasePointerCapture(event.pointerId);
      const available = getAvailableWidth();
      if (available === null) return;
      writePanelWidthToWindow(
        typeof window === "undefined" ? null : window,
        clampPanelWidth(
          panelWidthFromPointer(event.clientX, window.innerWidth),
          available,
        ),
      );
    },
    [getAvailableWidth],
  );

  // A pointer is not the only way in: the handle is focusable so the width can
  // be set from the keyboard too, which is the only way it is reachable at all
  // for a reader who does not use one.
  const nudgeWidth = useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      const step =
        event.key === "ArrowLeft" ? 24 : event.key === "ArrowRight" ? -24 : 0;
      if (step === 0) return;
      event.preventDefault();
      const available = getAvailableWidth();
      if (available === null) return;
      const nextWidth = clampPanelWidth(width + step, available);
      onWidthChange(nextWidth);
      writePanelWidthToWindow(typeof window === "undefined" ? null : window, nextWidth);
    },
    [getAvailableWidth, onWidthChange, width],
  );

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
  // Only the rendered preview carries the reporter; the source view has to show
  // the file the agent actually wrote.
  const previewDocument = useMemo(
    () => (previewKind === "html" ? withScriptErrorReporter(previewContent) : previewContent),
    [previewContent, previewKind],
  );
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
      aria-label="Deliverables"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize deliverables"
        tabIndex={0}
        className={styles.resizer}
        onPointerDown={startResize}
        onPointerMove={onResize}
        onPointerUp={endResize}
        onPointerCancel={endResize}
        onKeyDown={nudgeWidth}
      />
      <div className={styles.header}>
        <h2>Deliverables</h2>
        <span className={styles.count}>{artifacts.length}</span>
        <span className={styles.headerSpacer} />
        <button
          type="button"
          className={styles.headerButton}
          onClick={() => setMaximised((value) => !value)}
          aria-label={maximised ? "Restore panel" : "Maximise panel"}
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
                    srcDoc={previewDocument}
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
