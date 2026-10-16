import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/api/server.js";
import { looksLikeAudio, TranscribeError, TranscribeService } from "../src/core/transcribe.js";
import { openDb } from "../src/db/index.js";
import { services } from "./api.test.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A stand-in for the whisper command: writes <file name>.txt into --output_dir, like the real one. */
function fakeWhisper(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "fake-whisper-"));
  dirs.push(dir);
  const path = join(dir, "whisper");
  writeFileSync(path, `#!/bin/bash\n[ "$1" = "--help" ] && exit 0\nall="$*"; file="$1"; shift\nwhile [ $# -gt 0 ]; do case "$1" in --output_dir) out="$2";; esac; shift; done\n${body.replaceAll("$OUT", '"$out/$(basename "${file%.*}").txt"')}\n`);
  chmodSync(path, 0o755);
  return path;
}

const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(2000, 1)]);
const svc = (command: string, extra = {}) => new TranscribeService({ command, model: "medium", language: "he", ...extra });

describe("looksLikeAudio", () => {
  it("accepts real containers and rejects anything else", () => {
    expect(looksLikeAudio("audio/webm", WEBM)).toBe(true);
    expect(looksLikeAudio("audio/ogg", Buffer.from("OggS....."))).toBe(true);
    expect(looksLikeAudio("audio/mp4", Buffer.from("\0\0\0\x18ftypM4A "))).toBe(true);
    expect(looksLikeAudio("audio/wav", Buffer.from("RIFF\0\0\0\0WAVEfmt "))).toBe(true);
    expect(looksLikeAudio("audio/mpeg", Buffer.from("ID3\x04"))).toBe(true);
    expect(looksLikeAudio("audio/webm", Buffer.from("#!/bin/sh\necho hi"))).toBe(false);
    expect(looksLikeAudio("text/plain", WEBM)).toBe(false);
  });
});

describe("TranscribeService", () => {
  it("runs whisper on a temporary copy, returns the clean text and deletes the audio", async () => {
    const before = readdirSync(tmpdir()).filter((n) => n.startsWith("voice-")).length;
    const s = svc(fakeWhisper('printf "שלום   עולם\\n\\nזה בדיקה\\n" > $OUT'));
    expect(await s.transcribe(WEBM, "audio/webm")).toBe("שלום עולם זה בדיקה");
    expect(readdirSync(tmpdir()).filter((n) => n.startsWith("voice-")).length).toBe(before);
  });

  it("passes the model and language to whisper", async () => {
    const dir = mkdtempSync(join(tmpdir(), "args-"));
    dirs.push(dir);
    await svc(fakeWhisper(`echo "$all" > ${dir}/args; printf ok > $OUT`)).transcribe(WEBM, "audio/webm");
    const args = readFileSync(join(dir, "args"), "utf8");
    expect(args).toContain("--model medium");
    expect(args).toContain("--language he");
    expect(args).toContain("--output_format txt");
  });

  it("returns an empty string for silence, and says so plainly on failure", async () => {
    expect(await svc(fakeWhisper("printf '' > $OUT")).transcribe(WEBM, "audio/webm")).toBe("");
    await expect(svc(fakeWhisper("exit 3")).transcribe(WEBM, "audio/webm")).rejects.toThrow(TranscribeError);
    await expect(svc("/definitely/not/here").transcribe(WEBM, "audio/webm")).rejects.toThrow(/נכשל/);
  });

  it("gives up on a hung transcription", async () => {
    await expect(svc(fakeWhisper("sleep 5"), { timeoutMs: 300 }).transcribe(WEBM, "audio/webm")).rejects.toThrow(/יותר מדי זמן/);
  });

  it("handles one recording at a time", async () => {
    const log = join(mkdtempSync(join(tmpdir(), "order-")), "log");
    dirs.push(join(log, ".."));
    const s = svc(fakeWhisper(`echo start >> ${log}; sleep 0.3; echo end >> ${log}; printf x > $OUT`));
    await Promise.all([s.transcribe(WEBM, "audio/webm"), s.transcribe(WEBM, "audio/webm")]);
    expect(readFileSync(log, "utf8")).toBe("start\nend\nstart\nend\n");
  });

  it("reports availability", async () => {
    expect(await svc(fakeWhisper("exit 0")).available()).toBe(true);
    expect(await svc("/definitely/not/here").available()).toBe(false);
  });
});

describe("POST /transcribe", () => {
  const TOKEN = "t".repeat(40);
  const auth = { authorization: `Bearer ${TOKEN}` };
  const app = (transcribe?: TranscribeService) => buildApp({ db: openDb(":memory:"), accessToken: TOKEN, ...services(openDb(":memory:")), transcribe });
  const post = (a: ReturnType<typeof app>, payload: Buffer, type = "audio/webm") => a.inject({ method: "POST", url: "/transcribe", headers: { ...auth, "content-type": type }, payload });

  it("returns the text of a recording", async () => {
    const a = app(svc(fakeWhisper("printf 'הקלטה ראשונה' > $OUT")));
    const res = await post(a, WEBM);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ text: "הקלטה ראשונה" });
    expect((await a.inject({ method: "GET", url: "/settings", headers: auth })).json().transcribe).toBe(true);
  });

  it("refuses non audio, tiny files and a wrong type, and needs the token", async () => {
    const a = app(svc(fakeWhisper("printf x > $OUT")));
    expect((await post(a, Buffer.from("#!/bin/sh\n" + "x".repeat(2000)))).statusCode).toBe(422);
    expect((await post(a, Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1]))).statusCode).toBe(422);
    expect((await post(a, WEBM, "audio/flac")).statusCode).toBeGreaterThanOrEqual(400);
    expect((await a.inject({ method: "POST", url: "/transcribe", headers: { "content-type": "audio/webm" }, payload: WEBM })).statusCode).toBe(401);
  });

  it("says the feature is missing when whisper is not installed", async () => {
    const a = app(svc("/definitely/not/here"));
    const res = await post(a, WEBM);
    expect(res.statusCode).toBe(501);
    expect(res.json().message).toContain("Whisper");
    expect((await a.inject({ method: "GET", url: "/settings", headers: auth })).json().transcribe).toBe(false);
    expect((await post(app(), WEBM)).statusCode).toBe(501);
  });
});
