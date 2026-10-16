import { useCallback, useEffect, useRef, useState } from "react";
import { useApi } from "../hooks";
import { transcribeAudio } from "./api";

export type VoiceState = "idle" | "recording" | "transcribing";
const MAX_SECONDS = 120;

/** Prefer what the browser can record: webm/opus in Chrome and Android, mp4 in Safari. */
function pickType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  return ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((t) => MediaRecorder.isTypeSupported(t));
}

/** Whether the core can turn speech into text (Whisper installed on the computer). */
export function useVoiceAvailable(): boolean {
  return useApi<{ transcribe?: boolean }>("/settings").data?.transcribe === true;
}

/**
 * Record from the microphone, send to the core, hand the text back. One tap starts, the next stops
 * (or it stops itself after two minutes). `onText` gets the transcript, `onProblem` a message for the owner.
 */
export function useVoice(onText: (text: string) => void, onProblem: (message: string) => void) {
  const [state, setState] = useState<VoiceState>("idle");
  const [seconds, setSeconds] = useState(0);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const discard = useRef(false);

  const release = useCallback(() => {
    clearInterval(timer.current);
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
  }, []);

  // Leaving the screen while recording throws the recording away.
  useEffect(() => () => {
    discard.current = true;
    if (recorder.current?.state === "recording") recorder.current.stop();
    release();
  }, [release]);

  const stop = useCallback(() => {
    if (recorder.current?.state === "recording") recorder.current.stop();
  }, []);

  const start = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      return onProblem("ההקלטה דורשת חיבור מאובטח (HTTPS) ודפדפן שתומך בה.");
    }
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      return onProblem("אין הרשאה למיקרופון. אפשר לאשר אותה בהגדרות הדפדפן.");
    }
    const type = pickType();
    const chunks: Blob[] = [];
    const rec = new MediaRecorder(stream.current, type ? { mimeType: type } : undefined);
    recorder.current = rec;
    discard.current = false;
    rec.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);
    rec.onstop = async () => {
      release();
      if (discard.current) return setState("idle");
      setState("transcribing");
      try {
        const text = await transcribeAudio(new Blob(chunks, { type: rec.mimeType || type || "audio/webm" }));
        if (text) onText(text);
        else onProblem("לא שמעתי כלום. נסה שוב, קרוב יותר למיקרופון.");
      } catch (err) {
        const body = (err as { body?: { message?: string } }).body;
        onProblem(body?.message ?? "התמלול נכשל. נסה שוב.");
      } finally {
        setState("idle");
      }
    };
    rec.start();
    setSeconds(0);
    setState("recording");
    timer.current = setInterval(() => {
      setSeconds((s) => {
        if (s + 1 >= MAX_SECONDS) stop();
        return s + 1;
      });
    }, 1000);
  }, [onText, onProblem, release, stop]);

  const toggle = useCallback(() => {
    if (state === "recording") stop();
    else if (state === "idle") void start();
  }, [state, start, stop]);

  return { state, seconds, toggle };
}

export const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
