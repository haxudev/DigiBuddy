"use client";

import {
  KeyboardEvent,
  PointerEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  MAX_RECORDING_SECONDS,
  encodePcmWav,
  formatRecordingTime,
  recorderMimeType,
} from "@/lib/voice-input";
import styles from "./voice-input-button.module.css";

type VoiceStatus =
  | "idle"
  | "permission"
  | "recording"
  | "encoding"
  | "transcribing";

type Props = {
  contextId: string;
  disabled?: boolean;
  onTranscript(text: string, contextId: string): void;
  onError(message: string): void;
};

async function toWav(recording: Blob): Promise<Blob> {
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(await recording.arrayBuffer());
    const channels = Array.from(
      { length: decoded.numberOfChannels },
      (_, index) => decoded.getChannelData(index),
    );
    return encodePcmWav(channels, decoded.sampleRate);
  } finally {
    await context.close();
  }
}

async function responseError(response: Response): Promise<string> {
  const payload = (await response.json().catch(() => null)) as {
    error?: unknown;
  } | null;
  return typeof payload?.error === "string"
    ? payload.error
    : `Speech transcription failed with HTTP ${response.status}.`;
}

export default function VoiceInputButton({
  contextId,
  disabled = false,
  onTranscript,
  onError,
}: Props) {
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [elapsed, setElapsed] = useState(0);
  const heldRef = useRef(false);
  const startingRef = useRef(false);
  const cancelledRef = useRef(false);
  const mountedRef = useRef(true);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const contextRef = useRef("");
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const onTranscriptRef = useRef(onTranscript);
  const onErrorRef = useRef(onError);
  useLayoutEffect(() => {
    onTranscriptRef.current = onTranscript;
    onErrorRef.current = onError;
  }, [onError, onTranscript]);

  function clearTimers() {
    if (intervalRef.current) clearInterval(intervalRef.current);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    intervalRef.current = null;
    timeoutRef.current = null;
  }

  function releaseStream() {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }

  function fail(error: unknown) {
    clearTimers();
    releaseStream();
    startingRef.current = false;
    if (!mountedRef.current) return;
    setStatus("idle");
    setElapsed(0);
    onErrorRef.current(
      error instanceof Error ? error.message : "Voice input failed.",
    );
  }

  async function finishRecording(recording: Blob, targetContext: string) {
    if (!mountedRef.current || cancelledRef.current) return;
    try {
      setStatus("encoding");
      const wav = await toWav(recording);
      if (!mountedRef.current || cancelledRef.current) return;
      setStatus("transcribing");
      const controller = new AbortController();
      abortRef.current = controller;
      const response = await fetch("/api/transcribe", {
        method: "POST",
        headers: { "Content-Type": "audio/wav" },
        body: wav,
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(await responseError(response));
      const payload = (await response.json()) as { text?: unknown };
      const text = typeof payload.text === "string" ? payload.text.trim() : "";
      if (!text) throw new Error("No speech could be recognized.");
      if (!mountedRef.current || cancelledRef.current) return;
      setStatus("idle");
      setElapsed(0);
      onTranscriptRef.current(text, targetContext);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      fail(error);
    } finally {
      abortRef.current = null;
    }
  }

  function stopRecording(cancel = false) {
    heldRef.current = false;
    cancelledRef.current = cancel;
    clearTimers();
    const recorder = recorderRef.current;
    if (recorder?.state === "recording") {
      recorder.stop();
      return;
    }
    if (cancel) {
      releaseStream();
      if (mountedRef.current) {
        setStatus("idle");
        setElapsed(0);
      }
    }
  }

  async function startRecording() {
    if (
      disabled ||
      !contextId ||
      startingRef.current ||
      recorderRef.current?.state === "recording"
    ) {
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || !globalThis.MediaRecorder) {
      fail(new Error("This browser does not support microphone recording."));
      return;
    }

    startingRef.current = true;
    cancelledRef.current = false;
    contextRef.current = contextId;
    setStatus("permission");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      if (!mountedRef.current || !heldRef.current || cancelledRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        startingRef.current = false;
        if (mountedRef.current) setStatus("idle");
        return;
      }

      streamRef.current = stream;
      chunksRef.current = [];
      const mimeType = recorderMimeType(MediaRecorder.isTypeSupported);
      const recorder = new MediaRecorder(
        stream,
        mimeType ? { mimeType } : undefined,
      );
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onerror = () => {
        cancelledRef.current = true;
        fail(new Error("The microphone recording failed."));
      };
      recorder.onstop = () => {
        const cancelled = cancelledRef.current;
        const targetContext = contextRef.current;
        const recording = new Blob(chunksRef.current, {
          type: recorder.mimeType || "application/octet-stream",
        });
        recorderRef.current = null;
        startingRef.current = false;
        releaseStream();
        if (cancelled) {
          if (mountedRef.current) {
            setStatus("idle");
            setElapsed(0);
          }
          return;
        }
        void finishRecording(recording, targetContext);
      };

      recorder.start(250);
      startingRef.current = false;
      const startedAt = Date.now();
      setElapsed(0);
      setStatus("recording");
      intervalRef.current = setInterval(
        () => setElapsed((Date.now() - startedAt) / 1000),
        250,
      );
      timeoutRef.current = setTimeout(
        () => stopRecording(),
        MAX_RECORDING_SECONDS * 1000,
      );
    } catch (error) {
      fail(
        error instanceof DOMException && error.name === "NotAllowedError"
          ? new Error("Microphone permission was denied.")
          : error,
      );
    }
  }

  useEffect(
    () => () => {
      mountedRef.current = false;
      cancelledRef.current = true;
      clearTimers();
      abortRef.current?.abort();
      const recorder = recorderRef.current;
      if (recorder?.state === "recording") recorder.stop();
      releaseStream();
    },
    [],
  );

  function pointerDown(event: PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    heldRef.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    void startRecording();
  }

  function pointerUp(event: PointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    heldRef.current = false;
    if (status === "recording") stopRecording();
  }

  function keyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      stopRecording(true);
      return;
    }
    if ((event.key === " " || event.key === "Enter") && !event.repeat) {
      event.preventDefault();
      heldRef.current = true;
      void startRecording();
    }
  }

  function keyUp(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== " " && event.key !== "Enter") return;
    event.preventDefault();
    heldRef.current = false;
    if (status === "recording") stopRecording();
  }

  const statusText =
    status === "permission"
      ? "Allow microphone access…"
      : status === "recording"
        ? `${formatRecordingTime(elapsed)} · Release to send · Esc to cancel`
        : status === "encoding"
          ? "Preparing audio…"
          : status === "transcribing"
            ? "Detecting language and transcribing…"
            : "";
  const processing =
    status === "permission" || status === "encoding" || status === "transcribing";

  return (
    <>
      <button
        type="button"
        className={styles.button}
        data-recording={status === "recording" ? "true" : undefined}
        disabled={(disabled && status === "idle") || processing}
        aria-label={
          status === "recording"
            ? "Release to transcribe and send voice message"
            : "Hold to record a voice message"
        }
        aria-pressed={status === "recording"}
        title="Hold to talk"
        onPointerDown={pointerDown}
        onPointerUp={pointerUp}
        onPointerCancel={() => stopRecording(true)}
        onKeyDown={keyDown}
        onKeyUp={keyUp}
      >
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <path d="M12 15.4a3.4 3.4 0 0 0 3.4-3.4V6.4a3.4 3.4 0 1 0-6.8 0V12a3.4 3.4 0 0 0 3.4 3.4Zm-5.8-4.1a.8.8 0 0 1 1.6 0v.7a4.2 4.2 0 0 0 8.4 0v-.7a.8.8 0 1 1 1.6 0v.7a5.8 5.8 0 0 1-5 5.74V20h2.1a.8.8 0 1 1 0 1.6H9.1a.8.8 0 1 1 0-1.6h2.1v-2.26A5.8 5.8 0 0 1 6.2 12v-.7Z" />
        </svg>
      </button>
      {statusText && (
        <span className={styles.status} role="status" aria-live="polite">
          {statusText}
        </span>
      )}
    </>
  );
}
