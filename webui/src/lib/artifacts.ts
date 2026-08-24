import {
  MANAGED_ARTIFACT_ID,
  isManagedArtifactName,
} from "./artifact-reference.ts";

export type Artifact = {
  id: string;
  title: string;
  kind: "html" | "markdown" | "code" | "link";
  language: string;
  content: string;
  url: string;
  managed?: boolean;
  mimeType?: string;
  size?: number;
};

const CODE_BLOCK = /```([^\n`]*)\r?\n([\s\S]*?)```/g;
const LINK = /https?:\/\/[^\s<>()[\]"']+/g;
const MARKDOWN_LINK = /\[([^\]]+)\]\(([^)\s]+)\)/g;
const WORKSPACE_PATH = /`?\/workspace\/[^\s`<>()\[\]"']+`?/g;
const ARTIFACT_COMMENT =
  /<!--\s*digibuddy-artifacts:(\{[\s\S]*?\})\s*-->/g;
const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;

const PREVIEWABLE_EXTENSIONS = new Set([
  "pptx",
  "docx",
  "xlsx",
  "pdf",
  "csv",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "svg",
  "webp",
  "htm",
  "html",
  "md",
  "markdown",
  "json",
  "zip",
  "txt",
]);

function fileNameFromUrl(value: string): string {
  try {
    const url = new URL(value);
    const last = url.pathname.split("/").filter(Boolean).pop() || "";
    return decodeURIComponent(last);
  } catch {
    return "";
  }
}

function extensionOf(name: string): string {
  const index = name.lastIndexOf(".");
  if (index <= 0 || index === name.length - 1) return "";
  return name.slice(index + 1).toLowerCase();
}

function isWorkspaceReference(value: string): boolean {
  if (value.startsWith("/workspace/")) return true;
  try {
    return new URL(value).pathname.startsWith("/workspace/");
  } catch {
    return false;
  }
}

function managedArtifacts(text: string, messageId: string): Artifact[] {
  const artifacts: Artifact[] = [];
  let index = 0;
  ARTIFACT_COMMENT.lastIndex = 0;
  for (
    let match = ARTIFACT_COMMENT.exec(text);
    match;
    match = ARTIFACT_COMMENT.exec(text)
  ) {
    try {
      const payload = JSON.parse(match[1]) as Record<string, unknown>;
      if (payload.version !== 1 || !Array.isArray(payload.artifacts)) continue;
      for (const value of payload.artifacts) {
        if (!value || typeof value !== "object") continue;
        const raw = value as Record<string, unknown>;
        const id = typeof raw.id === "string" ? raw.id : "";
        const name = typeof raw.name === "string" ? raw.name : "";
        const size = typeof raw.size === "number" ? raw.size : -1;
        const mimeType = typeof raw.mimeType === "string" ? raw.mimeType : "";
        const extension = extensionOf(name);
        if (
          !MANAGED_ARTIFACT_ID.test(id) ||
          !isManagedArtifactName(name) ||
          !PREVIEWABLE_EXTENSIONS.has(extension) ||
          !Number.isSafeInteger(size) ||
          size <= 0 ||
          size > MAX_ARTIFACT_BYTES
        ) {
          continue;
        }
        artifacts.push({
          id: `${messageId}-managed-${id}-${index}`,
          title: name,
          kind: "link",
          language: extension,
          content: "",
          url: `/api/artifacts/${id}/${encodeURIComponent(name)}`,
          managed: true,
          mimeType,
          size,
        });
        index += 1;
      }
    } catch {
      // A malformed or incomplete streamed comment is ignored until it is valid.
    }
  }
  return artifacts;
}

export function stripArtifactMetadata(text: string): string {
  ARTIFACT_COMMENT.lastIndex = 0;
  let cleaned = text.replace(ARTIFACT_COMMENT, "");
  cleaned = cleaned.replace(MARKDOWN_LINK, (match, label, href) =>
    isWorkspaceReference(href) ? label : match,
  );
  LINK.lastIndex = 0;
  cleaned = cleaned.replace(LINK, (match, offset, source) => {
    if (source[offset - 1] === "(") return match;
    const url = match.replace(/[.,;:]+$/, "");
    const suffix = match.slice(url.length);
    const name = fileNameFromUrl(url);
    if (isWorkspaceReference(url)) {
      return `${name ? `\`${name}\`` : "workspace file"}${suffix}`;
    }
    if (PREVIEWABLE_EXTENSIONS.has(extensionOf(name))) {
      return `[${name}](${url})${suffix}`;
    }
    return match;
  });
  return cleaned.replace(WORKSPACE_PATH, (match) => {
    const path = match.replaceAll("`", "");
    const name = path.split("/").filter(Boolean).pop() || "workspace file";
    return `\`${name}\``;
  });
}

/**
 * The fence info string may carry a file name, either as `html title=a.html`
 * or as the bare second word used by many agents (```python report.py).
 */
function parseInfo(info: string): { language: string; title: string } {
  const trimmed = info.trim();
  if (!trimmed) return { language: "", title: "" };
  const titleMatch = trimmed.match(/(?:title|file|filename|path)\s*=\s*"?([^"\s]+)"?/i);
  const [language] = trimmed.split(/\s+/);
  const rest = trimmed.slice(language.length).trim();
  const title = titleMatch
    ? titleMatch[1]
    : rest && !rest.includes("=")
      ? rest
      : "";
  return { language: language.toLowerCase(), title };
}

function artifactKind(language: string): Artifact["kind"] {
  if (language === "html" || language === "htm" || language === "svg") {
    return "html";
  }
  if (language === "md" || language === "markdown") return "markdown";
  return "code";
}

/**
 * Managed metadata is the primary transport. Named code blocks and external
 * download links remain supported for older agents and direct integrations.
 */
export function extractArtifacts(text: string, messageId: string): Artifact[] {
  const artifacts = managedArtifacts(text, messageId);
  const seen = new Set<string>();
  const managedNames = new Set(
    artifacts.filter((artifact) => artifact.managed).map((artifact) => artifact.title),
  );
  artifacts.forEach((artifact) => seen.add(artifact.url));
  let index = artifacts.length;

  CODE_BLOCK.lastIndex = 0;
  for (let match = CODE_BLOCK.exec(text); match; match = CODE_BLOCK.exec(text)) {
    const { language, title } = parseInfo(match[1]);
    if (!language || language.startsWith("ask")) continue;
    const content = match[2];
    if (!content.trim()) continue;
    const kind = artifactKind(language);
    // Short snippets are explanation, not a deliverable, unless named.
    if (kind === "code" && !title && content.trim().split(/\r?\n/).length < 8) {
      continue;
    }
    artifacts.push({
      id: `${messageId}-block-${index}`,
      title: title || `${language} snippet`,
      kind,
      language,
      content,
      url: "",
    });
    index += 1;
  }

  LINK.lastIndex = 0;
  for (let match = LINK.exec(text); match; match = LINK.exec(text)) {
    const url = match[0].replace(/[.,;:]+$/, "");
    if (seen.has(url)) continue;
    const name = fileNameFromUrl(url);
    const extension = extensionOf(name);
    if (
      isWorkspaceReference(url) ||
      managedNames.has(name) ||
      !PREVIEWABLE_EXTENSIONS.has(extension)
    ) {
      continue;
    }
    seen.add(url);
    artifacts.push({
      id: `${messageId}-link-${index}`,
      title: name,
      kind: "link",
      language: extension,
      content: "",
      url,
    });
    index += 1;
  }

  return artifacts;
}

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);

export function isImageArtifact(artifact: Artifact): boolean {
  return artifact.kind === "link" && IMAGE_EXTENSIONS.has(artifact.language);
}

export type ArtifactPreviewKind =
  | "download"
  | "html"
  | "image"
  | "markdown"
  | "pdf"
  | "text";

export function artifactPreviewKind(artifact: Artifact): ArtifactPreviewKind {
  if (artifact.kind === "html") return "html";
  if (artifact.kind === "markdown") return "markdown";
  if (artifact.kind === "code") return "text";
  if (isImageArtifact(artifact)) return "image";
  if (artifact.language === "pdf") return "pdf";
  if (["html", "htm", "svg"].includes(artifact.language)) return "html";
  if (["md", "markdown"].includes(artifact.language)) return "markdown";
  if (["csv", "json", "txt"].includes(artifact.language)) return "text";
  return "download";
}
