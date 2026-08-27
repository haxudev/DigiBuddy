export const MAX_RECORDING_SECONDS = 60;

export const RECORDER_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/ogg;codecs=opus",
  "audio/mp4",
] as const;

export function recorderMimeType(
  isTypeSupported: (mimeType: string) => boolean,
): string {
  return RECORDER_MIME_TYPES.find(isTypeSupported) ?? "";
}

export function encodePcmWav(
  channels: readonly Float32Array[],
  sampleRate: number,
): Blob {
  if (channels.length === 0 || channels[0].length === 0) {
    throw new Error("The recording contained no audio.");
  }

  const frameCount = channels[0].length;
  const bytes = new ArrayBuffer(44 + frameCount * 2);
  const view = new DataView(bytes);
  const writeText = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };

  writeText(0, "RIFF");
  view.setUint32(4, 36 + frameCount * 2, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, frameCount * 2, true);

  for (let frame = 0; frame < frameCount; frame += 1) {
    let sample = 0;
    for (const channel of channels) sample += channel[frame] ?? 0;
    sample = Math.max(-1, Math.min(1, sample / channels.length));
    view.setInt16(
      44 + frame * 2,
      sample < 0 ? sample * 0x8000 : sample * 0x7fff,
      true,
    );
  }

  return new Blob([bytes], { type: "audio/wav" });
}

export function formatRecordingTime(seconds: number): string {
  const bounded = Math.max(0, Math.min(MAX_RECORDING_SECONDS, seconds));
  return `0:${String(Math.floor(bounded)).padStart(2, "0")}`;
}
