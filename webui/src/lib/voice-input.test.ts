import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_RECORDING_SECONDS,
  encodePcmWav,
  formatRecordingTime,
  recorderMimeType,
} from "./voice-input.ts";

test("chooses the first browser-supported recording format", () => {
  assert.equal(
    recorderMimeType((type) => type === "audio/ogg;codecs=opus"),
    "audio/ogg;codecs=opus",
  );
  assert.equal(recorderMimeType(() => false), "");
});

test("encodes multichannel samples as mono PCM WAV", async () => {
  const wav = encodePcmWav(
    [new Float32Array([1, -1]), new Float32Array([0.5, -0.5])],
    48_000,
  );
  const view = new DataView(await wav.arrayBuffer());
  assert.equal(wav.type, "audio/wav");
  assert.equal(await wav.slice(0, 4).text(), "RIFF");
  assert.equal(await wav.slice(8, 12).text(), "WAVE");
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 48_000);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getInt16(44, true), Math.floor(0.75 * 0x7fff));
});

test("formats and caps the recording timer", () => {
  assert.equal(formatRecordingTime(7.9), "0:07");
  assert.equal(formatRecordingTime(MAX_RECORDING_SECONDS + 10), "0:60");
});
