import { NotSignedInError, requirePrincipal } from "@/lib/identity";
import {
  MAX_TRANSCRIPTION_BYTES,
  TranscriptionPayloadTooLargeError,
  TranscriptionUpstreamError,
  isPcmWav,
  readLimitedBody,
  transcribeWav,
} from "@/lib/transcription";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UPSTREAM_TIMEOUT_MS = 90_000;

function jsonError(error: string, status: number): Response {
  return Response.json(
    { error },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: Request) {
  try {
    requirePrincipal(request.headers);
  } catch (error) {
    if (error instanceof NotSignedInError) {
      return jsonError(error.message, 403);
    }
    throw error;
  }

  if (request.headers.get("content-type")?.split(";")[0].trim() !== "audio/wav") {
    return jsonError("The recording must be sent as audio/wav.", 415);
  }

  const declaredLength = Number(request.headers.get("content-length") || "0");
  if (declaredLength > MAX_TRANSCRIPTION_BYTES) {
    return jsonError("The recording is too large.", 413);
  }

  let bytes: Uint8Array;
  try {
    bytes = await readLimitedBody(request.body, MAX_TRANSCRIPTION_BYTES);
  } catch (error) {
    if (!(error instanceof TranscriptionPayloadTooLargeError)) throw error;
    return jsonError("The recording is too large.", 413);
  }
  if (!isPcmWav(bytes)) {
    return jsonError("The recording is not a valid WAV file.", 400);
  }

  try {
    const text = await transcribeWav(bytes, {
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    return Response.json(
      { text },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof TranscriptionUpstreamError) {
      const status =
        error.status === 400 || error.status === 413 || error.status === 422
          ? error.status
          : error.status === 429
            ? 429
            : 502;
      return jsonError(error.message, status);
    }
    if (error instanceof DOMException && error.name === "TimeoutError") {
      return jsonError("Speech transcription timed out.", 504);
    }
    console.error("speech transcription unavailable", error);
    return jsonError("Speech transcription is unavailable.", 502);
  }
}
