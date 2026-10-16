import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Spoken input could not be turned into text. The message is shown to the owner (Hebrew). */
export class TranscribeError extends Error {}

export const MAX_AUDIO_BYTES = 15 * 1024 * 1024;

/** Audio types the app records: Chrome and Android give webm or ogg, Safari gives mp4. Uploads (wav, mp3) are fine too. */
export const AUDIO_MIME = ["audio/webm", "audio/ogg", "audio/mp4", "audio/x-m4a", "audio/mpeg", "audio/wav", "audio/x-wav"] as const;

const EXT: Record<string, string> = {
  "audio/webm": ".webm", "audio/ogg": ".ogg", "audio/mp4": ".m4a", "audio/x-m4a": ".m4a", "audio/mpeg": ".mp3", "audio/wav": ".wav", "audio/x-wav": ".wav",
};

/** The type must match the first bytes: only real audio containers reach ffmpeg, which would otherwise read almost anything. */
export function looksLikeAudio(mime: string, data: Buffer): boolean {
  const at = (offset: number, text: string) => data.subarray(offset, offset + text.length).toString("latin1") === text;
  switch (mime) {
    case "audio/webm": return data[0] === 0x1a && data[1] === 0x45 && data[2] === 0xdf && data[3] === 0xa3;
    case "audio/ogg": return at(0, "OggS");
    case "audio/mp4": case "audio/x-m4a": return at(4, "ftyp");
    case "audio/wav": case "audio/x-wav": return at(0, "RIFF") && at(8, "WAVE");
    case "audio/mpeg": return at(0, "ID3") || (data[0] === 0xff && ((data[1] ?? 0) & 0xe0) === 0xe0);
    default: return false;
  }
}

export interface TranscribeOptions {
  /** The Whisper command line tool (openai-whisper). */
  command: string;
  model: string;
  language: string;
  timeoutMs?: number;
}

/**
 * Turns a recording into text on this computer with Whisper: nothing leaves the machine and no key is involved.
 * One recording at a time (the model is heavy); the audio is deleted as soon as the text is read.
 */
export class TranscribeService {
  private queue: Promise<unknown> = Promise.resolve();
  private ready: Promise<boolean> | null = null;

  constructor(private o: TranscribeOptions) {}

  /** Whether the Whisper command can be run on this computer. Checked once. */
  available(): Promise<boolean> {
    this.ready ??= new Promise((done) => execFile(this.o.command, ["--help"], { env: this.env(), timeout: 60_000 }, (err) => done(!err)));
    return this.ready;
  }

  transcribe(audio: Buffer, mime: string): Promise<string> {
    const run = this.queue.then(() => this.run(audio, mime));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private env(): NodeJS.ProcessEnv {
    // Homebrew's folders are added because a core started from Finder may not have them; HOME holds the downloaded model.
    return { PATH: `${process.env.PATH ?? ""}:/opt/homebrew/bin:/usr/local/bin`, HOME: process.env.HOME, LANG: "en_US.UTF-8", PYTHONUNBUFFERED: "1" };
  }

  private async run(audio: Buffer, mime: string): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), "voice-"));
    try {
      const file = join(dir, `recording${EXT[mime] ?? ".bin"}`);
      writeFileSync(file, audio);
      const { command, model, language, timeoutMs = 5 * 60_000 } = this.o;
      await new Promise<void>((done, fail) => {
        execFile(
          command,
          [file, "--model", model, "--language", language, "--task", "transcribe", "--output_format", "txt", "--output_dir", dir, "--fp16", "False", "--verbose", "False"],
          { env: this.env(), timeout: timeoutMs, maxBuffer: 5_000_000 },
          (err) => {
            if (!err) return done();
            const killed = "killed" in err && err.killed;
            fail(new TranscribeError(killed ? "התמלול לקח יותר מדי זמן. נסה הקלטה קצרה יותר." : "התמלול נכשל. נסה שוב."));
          },
        );
      });
      return readFileSync(join(dir, "recording.txt"), "utf8").replace(/\s+/g, " ").trim();
    } catch (err) {
      if (err instanceof TranscribeError) throw err;
      throw new TranscribeError("התמלול נכשל. נסה שוב.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
