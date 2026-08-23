"use client";

import { useState } from "react";
import type { Artifact } from "@/lib/artifacts";
import { isImageArtifact } from "@/lib/artifacts";
import Markdown from "./Markdown";
import styles from "./artifact-panel.module.css";

type Props = {
  artifacts: Artifact[];
};

function kindLabel(artifact: Artifact): string {
  if (artifact.kind === "link") return artifact.language.toUpperCase() || "FILE";
  return artifact.language.toUpperCase();
}

export default function ArtifactPanel({ artifacts }: Props) {
  const [selectedId, setSelectedId] = useState("");
  const [showSource, setShowSource] = useState(false);

  // Follow the newest deliverable unless the user pinned an older one.
  const selected =
    artifacts.find((artifact) => artifact.id === selectedId) ??
    artifacts[artifacts.length - 1];

  return (
    <aside className={styles.panel}>
      <header className={styles.header}>
        <h2>Deliverables</h2>
        <span className={styles.count}>{artifacts.length}</span>
      </header>

      {artifacts.length === 0 ? (
        <div className={styles.empty}>
          <p>Nothing produced yet.</p>
          <p className={styles.hint}>
            Files, HTML, and generated documents from Codex appear here for preview.
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
