import {
  ConfigStoreUnavailableError,
  ConfigValidationError,
  buildConfigStore,
} from "@/lib/admin-config";
import {
  RuntimeAuthError,
  logRuntimeRefusal,
  requireRuntimePrincipal,
  runtimeBundlePath,
} from "@/lib/runtime-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function failure(error: unknown): Response {
  if (error instanceof RuntimeAuthError) {
    logRuntimeRefusal("bundles", error);
    return Response.json({ error: error.message }, { status: error.status });
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
  console.error("runtime bundle request failed", error);
  return Response.json(
    { error: "Runtime configuration is unavailable." },
    { status: 500 },
  );
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ name: string; sha256: string }> },
) {
  try {
    await requireRuntimePrincipal(request.headers);
    const { name, sha256 } = await params;
    const path = runtimeBundlePath(name, sha256);
    const payload = await buildConfigStore().readBundle(path);
    if (!payload) return new Response("Bundle not found.", { status: 404 });
    return new Response(new Uint8Array(payload), {
      headers: {
        "Cache-Control": "private, max-age=31536000, immutable",
        "Content-Length": String(payload.byteLength),
        "Content-Type": "application/zip",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return failure(error);
  }
}
