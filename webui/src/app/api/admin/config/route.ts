import {
  AdminAuthError,
  requireAdmin,
  type AdminPrincipal,
} from "@/lib/admin-auth";
import {
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
        const document = await store.read(name);
        return [name, redactDocument(name, document)] as const;
      }),
    );
    return Response.json(Object.fromEntries(entries), {
      headers: { "Cache-Control": "no-store" },
    });
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

    await store.write(name, document);
    audit(principal, name);
    return Response.json({ document: name, value: redactDocument(name, document) });
  } catch (error) {
    return failure(error);
  }
}
