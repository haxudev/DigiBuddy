import {
  ConfigStoreUnavailableError,
  ConfigValidationError,
  buildConfigStore,
  type JsonDocument,
} from "@/lib/admin-config";
import {
  PayloadTooLargeError,
  RuntimeAuthError,
  logRuntimeRefusal,
  readBoundedBody,
  requireRuntimePrincipal,
  runtimeReadableDocument,
  runtimeWritableDocument,
} from "@/lib/runtime-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function failure(error: unknown): Response {
  if (error instanceof RuntimeAuthError) {
    logRuntimeRefusal("documents", error);
    return Response.json({ error: error.message }, { status: error.status });
  }
  if (error instanceof PayloadTooLargeError) {
    return Response.json({ error: error.message }, { status: 413 });
  }
  if (error instanceof ConfigValidationError) {
    return Response.json({ error: error.message }, { status: 400 });
  }
  if (error instanceof ConfigStoreUnavailableError) {
    return Response.json(
      { error: "Runtime configuration is unavailable." },
      { status: 503 },
    );
  }
  console.error("runtime document request failed", error);
  return Response.json(
    { error: "Runtime configuration is unavailable." },
    { status: 500 },
  );
}

function jsonDocument(payload: Buffer): JsonDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.toString("utf-8"));
  } catch {
    throw new ConfigValidationError("Request body must be JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigValidationError("Request body must be a JSON object.");
  }
  return parsed as JsonDocument;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  try {
    await requireRuntimePrincipal(request.headers);
    const { name } = await params;
    const documentName = runtimeReadableDocument(name);
    const document = await buildConfigStore().read(documentName);
    if (!document) {
      return Response.json({ error: "Document not found." }, { status: 404 });
    }
    return Response.json(document, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return failure(error);
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  try {
    await requireRuntimePrincipal(request.headers);
    const { name } = await params;
    const documentName = runtimeWritableDocument(name);
    const body = await readBoundedBody(request);
    await buildConfigStore().write(documentName, jsonDocument(body));
    return new Response(null, { status: 204 });
  } catch (error) {
    return failure(error);
  }
}
