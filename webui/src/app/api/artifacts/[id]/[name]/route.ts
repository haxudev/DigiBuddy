import {
  ConfigValidationError,
  artifactStoragePath,
  buildConfigStore,
} from "@/lib/admin-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CONTENT_TYPES: Record<string, string> = {
  csv: "text/csv; charset=utf-8",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  gif: "image/gif",
  htm: "text/html; charset=utf-8",
  html: "text/html; charset=utf-8",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  json: "application/json; charset=utf-8",
  markdown: "text/markdown; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  pdf: "application/pdf",
  png: "image/png",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  svg: "image/svg+xml",
  txt: "text/plain; charset=utf-8",
  webp: "image/webp",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  zip: "application/zip",
};

const INLINE_EXTENSIONS = new Set(["gif", "jpeg", "jpg", "pdf", "png", "webp"]);

function extensionOf(filename: string): string {
  const index = filename.lastIndexOf(".");
  return index > 0 ? filename.slice(index + 1).toLowerCase() : "";
}

function contentDisposition(filename: string, inline: boolean): string {
  const fallback = filename.replace(/[^\x20-\x7e]/g, "_");
  return `${inline ? "inline" : "attachment"}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; name: string }> },
) {
  try {
    const { id, name } = await params;
    artifactStoragePath(id, name);
    const payload = await buildConfigStore().readArtifact(id, name);
    if (!payload) return new Response("Artifact not found.", { status: 404 });

    const extension = extensionOf(name);
    const inline =
      INLINE_EXTENSIONS.has(extension) &&
      new URL(request.url).searchParams.get("download") !== "1";
    return new Response(new Uint8Array(payload), {
      headers: {
        "Cache-Control": "private, max-age=3600, immutable",
        "Content-Disposition": contentDisposition(name, inline),
        "Content-Length": String(payload.byteLength),
        "Content-Security-Policy":
          "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:",
        "Content-Type": CONTENT_TYPES[extension] || "application/octet-stream",
        "Cross-Origin-Resource-Policy": "same-origin",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      return new Response("Invalid artifact reference.", { status: 400 });
    }
    console.error("Could not read managed artifact", error);
    return new Response("Artifact storage is unavailable.", { status: 503 });
  }
}
