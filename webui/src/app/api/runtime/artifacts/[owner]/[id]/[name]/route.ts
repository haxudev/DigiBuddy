import {
  ConfigStoreUnavailableError,
  ConfigValidationError,
  buildConfigStore,
} from "@/lib/admin-config";
import {
  PayloadTooLargeError,
  RuntimeAuthError,
  logRuntimeRefusal,
  readBoundedBody,
  requireRuntimePrincipal,
  runtimeArtifactPath,
} from "@/lib/runtime-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function failure(error: unknown): Response {
  if (error instanceof RuntimeAuthError) {
    logRuntimeRefusal("artifacts", error);
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
  console.error("runtime artifact request failed", error);
  return Response.json(
    { error: "Runtime configuration is unavailable." },
    { status: 500 },
  );
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ owner: string; id: string; name: string }> },
) {
  try {
    await requireRuntimePrincipal(request.headers);
    const { owner, id, name } = await params;
    runtimeArtifactPath(owner, id, name);
    const payload = await readBoundedBody(request);
    await buildConfigStore().writeArtifact(
      id,
      name,
      payload,
      request.headers.get("content-type") ?? "application/octet-stream",
      owner,
    );
    return new Response(null, { status: 204 });
  } catch (error) {
    return failure(error);
  }
}
