export type Artifact = {
  id: string;
  title: string;
  kind: "html" | "markdown" | "code" | "link";
  language: string;
  content: string;
  url: string;
};

const CODE_BLOCK = /```([^\n`]*)\r?\n([\s\S]*?)```/g;
const LINK = /https?:\/\/[^\s<>()[\]"']+/g;

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
  "html",
  "md",
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
 * Deliverables are not a separate transport today: the agent embeds them in its
 * answer as code blocks or as download links. This turns both into preview
 * cards without changing the Responses protocol.
 */
export function extractArtifacts(text: string, messageId: string): Artifact[] {
  const artifacts: Artifact[] = [];
  const seen = new Set<string>();
  let index = 0;

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
    if (!PREVIEWABLE_EXTENSIONS.has(extension)) continue;
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

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp"]);

export function isImageArtifact(artifact: Artifact): boolean {
  return artifact.kind === "link" && IMAGE_EXTENSIONS.has(artifact.language);
}
