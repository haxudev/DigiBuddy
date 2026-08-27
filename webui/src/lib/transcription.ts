import { ManagedIdentityCredential } from "@azure/identity";

export const TRANSCRIPTION_API_VERSION = "2025-10-15";
export const TRANSCRIPTION_MODEL = "mai-transcribe-1.5";
export const MAX_TRANSCRIPTION_BYTES = 10 * 1024 * 1024;

type Environment = Record<string, string | undefined>;
type TokenCredential = {
  getToken(scope: string): Promise<{ token: string } | null>;
};
type Fetch = typeof fetch;

export class TranscriptionUpstreamError extends Error {
  readonly status: number;

  constructor(
    status: number,
    message: string,
  ) {
    super(message);
    this.status = status;
  }
}

export class TranscriptionPayloadTooLargeError extends Error {}

export async function readLimitedBody(
  stream: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<Uint8Array> {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new TranscriptionPayloadTooLargeError(
          "The recording is too large.",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function transcriptionEndpoint(
  environment: Environment = process.env,
): URL {
  const configured = environment.MAI_TRANSCRIBE_ENDPOINT?.trim();
  if (!configured) {
    throw new Error("MAI_TRANSCRIBE_ENDPOINT is not configured.");
  }

  const endpoint = new URL(configured);
  if (
    endpoint.protocol !== "https:" ||
    !endpoint.hostname.toLowerCase().endsWith(".cognitiveservices.azure.com")
  ) {
    throw new Error(
      "MAI_TRANSCRIBE_ENDPOINT must be an HTTPS Azure Cognitive Services endpoint.",
    );
  }

  endpoint.pathname = "/speechtotext/transcriptions:transcribe";
  endpoint.search = "";
  endpoint.searchParams.set("api-version", TRANSCRIPTION_API_VERSION);
  return endpoint;
}

export function transcriptionDefinition(): Record<string, unknown> {
  return {
    enhancedMode: {
      enabled: true,
      model: TRANSCRIPTION_MODEL,
    },
  };
}

export function isPcmWav(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 44) return false;
  return (
    String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.subarray(8, 12)) === "WAVE"
  );
}

export function transcriptionText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const combined = (payload as Record<string, unknown>).combinedPhrases;
  if (!Array.isArray(combined)) return "";
  return combined
    .map((entry) =>
      entry &&
      typeof entry === "object" &&
      typeof (entry as Record<string, unknown>).text === "string"
        ? String((entry as Record<string, unknown>).text).trim()
        : "",
    )
    .filter(Boolean)
    .join("\n")
    .trim();
}

function upstreamMessage(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const message = (payload as Record<string, unknown>).message;
  return typeof message === "string" ? message.trim() : "";
}

async function bearerToken(
  credential?: TokenCredential,
): Promise<string> {
  const clientId = process.env.AZURE_CLIENT_ID?.trim();
  const managedIdentity =
    credential ||
    (clientId
      ? new ManagedIdentityCredential(clientId)
      : new ManagedIdentityCredential());
  const accessToken = await managedIdentity.getToken(
    "https://cognitiveservices.azure.com/.default",
  );
  if (!accessToken?.token) {
    throw new Error(
      "Managed identity did not return a Cognitive Services access token.",
    );
  }
  return accessToken.token;
}

export async function transcribeWav(
  bytes: Uint8Array,
  options: {
    environment?: Environment;
    credential?: TokenCredential;
    fetchImpl?: Fetch;
    signal?: AbortSignal;
  } = {},
): Promise<string> {
  const endpoint = transcriptionEndpoint(options.environment);
  const form = new FormData();
  const audio = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(audio).set(bytes);
  form.append("audio", new Blob([audio], { type: "audio/wav" }), "recording.wav");
  form.append("definition", JSON.stringify(transcriptionDefinition()));

  const response = await (options.fetchImpl ?? fetch)(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${await bearerToken(options.credential)}`,
    },
    body: form,
    cache: "no-store",
    signal: options.signal,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new TranscriptionUpstreamError(
      response.status,
      upstreamMessage(payload) ||
        `Speech transcription failed with HTTP ${response.status}.`,
    );
  }

  const text = transcriptionText(payload);
  if (!text) {
    throw new TranscriptionUpstreamError(
      422,
      "No speech could be recognized in the recording.",
    );
  }
  return text;
}
