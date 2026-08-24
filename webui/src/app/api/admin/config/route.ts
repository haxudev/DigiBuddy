import {
  AdminAuthError,
  requireAdmin,
  type AdminPrincipal,
} from "@/lib/admin-auth";
import {
  ConfigConflictError,
  ConfigValidationError,
  DOCUMENTS,
  MODELS_DOCUMENT,
  assertWritableDocument,
  buildConfigStore,
  normaliseDocument,
  normaliseModels,
  preserveSecret,
  redactDocument,
  type DocumentName,
  type JsonDocument,
} from "@/lib/admin-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function failure(error: unknown): Response {
  if (error instanceof AdminAuthError) {
    return Response.json({ error: error.message }, { status: 403 });
  }
  if (error instanceof ConfigConflictError) {
    // Someone else saved between this reader's load and its save. Reporting it
    // is the whole point: overwriting would discard their change silently.
    return Response.json({ error: error.message }, { status: 409 });
  }
  if (error instanceof ConfigValidationError) {
    return Response.json({ error: error.message }, { status: 400 });
  }
  console.error("admin config request failed", error);
  return Response.json(
    { error: "Runtime configuration is unavailable." },
    { status: 500 },
  );
}

function audit(principal: AdminPrincipal, document: DocumentName): void {
  // Configuration changes alter what the agent can reach, so who changed what
  // must be recoverable from the logs. Values are deliberately not logged.
  console.info(
    `admin config updated document=${document} by=${principal.id || principal.name}`,
  );
}

export async function GET(request: Request) {
  try {
    requireAdmin(request.headers);
    const store = buildConfigStore();
    const entries = await Promise.all(
      DOCUMENTS.map(async (name) => {
        const { document, revision } = await store.readVersioned(name);
        return [name, { value: redactDocument(name, document), revision }] as const;
      }),
    );
    const documents = Object.fromEntries(
      entries.map(([name, entry]) => [name, entry.value]),
    );
    const revisions = Object.fromEntries(
      entries.map(([name, entry]) => [name, entry.revision]),
    );
    return Response.json(
      { ...documents, revisions },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return failure(error);
  }
}

export async function PUT(request: Request) {
  try {
    const principal = requireAdmin(request.headers);

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      throw new ConfigValidationError("Request body must be JSON.");
    }
    const body =
      payload && typeof payload === "object"
        ? (payload as Record<string, unknown>)
        : {};
    const name = assertWritableDocument(String(body.document ?? ""));
    const expectedRevision =
      typeof body.revision === "string" ? body.revision : undefined;

    const store = buildConfigStore();
    let document: JsonDocument;
    if (name === MODELS_DOCUMENT) {
      document = preserveSecret(
        normaliseModels(body.value),
        await store.read(MODELS_DOCUMENT),
      );
    } else {
      document = normaliseDocument(name, body.value);
    }

    const revision = await store.write(name, document, expectedRevision);
    audit(principal, name);
    return Response.json({
      document: name,
      value: redactDocument(name, document),
      revision,
    });
  } catch (error) {
    return failure(error);
  }
}
