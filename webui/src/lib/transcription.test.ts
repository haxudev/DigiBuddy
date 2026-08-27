import assert from "node:assert/strict";
import test from "node:test";
import {
  TRANSCRIPTION_API_VERSION,
  TRANSCRIPTION_DEPLOYMENT,
  TranscriptionPayloadTooLargeError,
  isPcmWav,
  readLimitedBody,
  transcriptionEndpoint,
  transcriptionText,
  transcribeWav,
} from "./transcription.ts";

function wavHeader(): Uint8Array {
  const bytes = new Uint8Array(44);
  bytes.set(Buffer.from("RIFF"), 0);
  bytes.set(Buffer.from("WAVE"), 8);
  return bytes;
}

test("builds a fixed trusted Azure OpenAI transcription endpoint", () => {
  const endpoint = transcriptionEndpoint({
    GPT_TRANSCRIBE_ENDPOINT:
      "https://demo.openai.azure.com/ignored?unsafe=true",
  });
  assert.equal(
    endpoint.toString(),
    `https://demo.openai.azure.com/openai/deployments/${TRANSCRIPTION_DEPLOYMENT}/audio/transcriptions?api-version=${TRANSCRIPTION_API_VERSION}`,
  );
  assert.throws(
    () =>
      transcriptionEndpoint({
        GPT_TRANSCRIBE_ENDPOINT: "https://example.com",
      }),
    /Azure OpenAI/,
  );
});

test("validates WAV headers and reads the GPT transcript", () => {
  assert.equal(isPcmWav(wavHeader()), true);
  assert.equal(isPcmWav(new Uint8Array(44)), false);
  assert.equal(transcriptionText({ text: " hello 世界 " }), "hello 世界");
});

test("stops reading a request body at the configured limit", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2]));
      controller.enqueue(new Uint8Array([3, 4]));
      controller.close();
    },
  });
  await assert.rejects(
    readLimitedBody(stream, 3),
    TranscriptionPayloadTooLargeError,
  );
  assert.deepEqual(
    await readLimitedBody(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.close();
        },
      }),
      3,
    ),
    new Uint8Array([1, 2, 3]),
  );
});

test("uses Cognitive Services managed identity without exposing a target", async () => {
  let scope = "";
  let requested = "";
  const text = await transcribeWav(wavHeader(), {
    environment: {
      GPT_TRANSCRIBE_ENDPOINT: "https://demo.openai.azure.com",
    },
    credential: {
      async getToken(value) {
        scope = value;
        return { token: "managed-token" };
      },
    },
    fetchImpl: async (input, init) => {
      requested = String(input);
      assert.equal(
        (init?.headers as Record<string, string>).Authorization,
        "Bearer managed-token",
      );
      const form = init?.body as FormData;
      assert.equal(form.get("file") instanceof Blob, true);
      assert.equal(form.has("definition"), false);
      return Response.json({ text: "recognized" });
    },
  });

  assert.equal(scope, "https://cognitiveservices.azure.com/.default");
  assert.match(requested, /gpt-transcribe\/audio\/transcriptions/);
  assert.equal(text, "recognized");
});
