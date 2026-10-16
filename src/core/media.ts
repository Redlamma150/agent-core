import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { Db } from "../db/index.js";
import { NotFoundError } from "./tasks.js";

/** Rejected upload: wrong type, too big, too many. The message is shown to the owner (Hebrew). */
export class MediaError extends Error {}

export const MAX_FILE_BYTES = 15 * 1024 * 1024;
export const MAX_FILES_PER_TASK = 10;

/**
 * Types the agent can actually read (images and PDFs through the Read tool, text as is).
 * No SVG or HTML: those can carry scripts and would be served back to the owner's browser.
 * No application/json either: the API's own JSON body parser must stay in charge of that type.
 */
export const ALLOWED_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
]);

const EXT: Record<string, string> = {
  "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif", "application/pdf": ".pdf",
  "text/plain": ".txt", "text/markdown": ".md", "text/csv": ".csv",
};

export interface Attachment {
  id: number;
  task_id: number;
  name: string;
  mime: string;
  size: number;
  /** "upload" for files the owner attached, "screenshot" for pictures the core took of the result. */
  kind: "upload" | "screenshot";
  created_at: string;
}

/** Keeps letters (Hebrew included), digits, dot, dash, underscore and space; everything else becomes "_". */
export function safeName(raw: string, mime: string): string {
  const base = basename(raw.replace(/\\/g, "/")).replace(/[^\p{L}\p{N}._\- ]/gu, "_").replace(/^\.+/, "").trim().slice(0, 80) || "file";
  const ext = EXT[mime] ?? "";
  return ext && !base.toLowerCase().endsWith(ext) && !/\.[A-Za-z0-9]{1,5}$/.test(base) ? base + ext : base;
}

/** The mime type must match the file's first bytes, so a renamed executable cannot pass as an image. */
export function matchesContent(mime: string, data: Buffer): boolean {
  const starts = (...bytes: number[]) => bytes.every((b, i) => data[i] === b);
  switch (mime) {
    case "image/png": return starts(0x89, 0x50, 0x4e, 0x47);
    case "image/jpeg": return starts(0xff, 0xd8, 0xff);
    case "image/gif": return starts(0x47, 0x49, 0x46, 0x38);
    case "image/webp": return data.subarray(0, 4).toString("latin1") === "RIFF" && data.subarray(8, 12).toString("latin1") === "WEBP";
    case "application/pdf": return data.subarray(0, 5).toString("latin1") === "%PDF-";
    default: return !data.subarray(0, 4096).includes(0); // text types: no NUL bytes
  }
}

/** Files the owner attaches to a task. Stored outside the project repo, so they never end up in a commit. */
export class MediaService {
  private root: string;

  constructor(private db: Db, uploadsDir: string) {
    this.root = resolve(uploadsDir);
  }

  /** The folder an agent is given read access to for this task. */
  taskDir(taskId: number): string {
    return join(this.root, String(taskId));
  }

  list(taskId: number): Attachment[] {
    return this.db.prepare("SELECT id, task_id, name, mime, size, kind, created_at FROM attachments WHERE task_id = ? ORDER BY id").all(taskId) as Attachment[];
  }

  save(taskId: number, rawName: string, mime: string, data: Buffer): Attachment {
    if (!this.db.prepare("SELECT 1 FROM tasks WHERE id = ?").get(taskId)) throw new NotFoundError(`task ${taskId} not found`);
    if (!ALLOWED_MIME.has(mime)) throw new MediaError("סוג הקובץ לא נתמך. אפשר תמונות, PDF וקבצי טקסט.");
    if (data.length === 0) throw new MediaError("הקובץ ריק.");
    if (data.length > MAX_FILE_BYTES) throw new MediaError("הקובץ גדול מדי (עד 15MB).");
    if (!matchesContent(mime, data)) throw new MediaError("תוכן הקובץ לא תואם לסוג שלו.");
    if (this.list(taskId).filter((a) => a.kind === "upload").length >= MAX_FILES_PER_TASK) throw new MediaError(`אפשר לצרף עד ${MAX_FILES_PER_TASK} קבצים למשימה.`);

    const name = safeName(rawName, mime);
    const dir = this.taskDir(taskId);
    mkdirSync(dir, { recursive: true });
    const info = this.db.prepare("INSERT INTO attachments (task_id, name, mime, size, path) VALUES (?, ?, ?, ?, '')").run(taskId, name, mime, data.length);
    const id = Number(info.lastInsertRowid);
    const path = join(dir, `${id}-${name}`);
    writeFileSync(path, data);
    this.db.prepare("UPDATE attachments SET path = ? WHERE id = ?").run(path, id);
    return { id, task_id: taskId, name, mime, size: data.length, kind: "upload", created_at: new Date().toISOString() };
  }

  /** A picture the core took of the task's result. Not counted against the owner's file limit and not shown to the agents. */
  saveScreenshot(taskId: number, name: string, data: Buffer): Attachment {
    if (!matchesContent("image/png", data)) throw new MediaError("הצילום אינו קובץ PNG תקין.");
    const dir = this.taskDir(taskId);
    mkdirSync(dir, { recursive: true });
    const info = this.db.prepare("INSERT INTO attachments (task_id, name, mime, size, path, kind) VALUES (?, ?, 'image/png', ?, '', 'screenshot')").run(taskId, name, data.length);
    const id = Number(info.lastInsertRowid);
    const path = join(dir, `${id}-${name}`);
    writeFileSync(path, data);
    this.db.prepare("UPDATE attachments SET path = ? WHERE id = ?").run(path, id);
    return { id, task_id: taskId, name, mime: "image/png", size: data.length, kind: "screenshot", created_at: new Date().toISOString() };
  }

  /** Clears the earlier screenshots of a task before new ones are taken (after a rejection and a rebuild). */
  removeScreenshots(taskId: number): void {
    const rows = this.db.prepare("SELECT id, path FROM attachments WHERE task_id = ? AND kind = 'screenshot'").all(taskId) as { id: number; path: string }[];
    for (const r of rows) rmSync(r.path, { force: true });
    this.db.prepare("DELETE FROM attachments WHERE task_id = ? AND kind = 'screenshot'").run(taskId);
  }

  /** Path and type of one attachment, for serving it back to the owner. */
  file(taskId: number, id: number): { path: string; name: string; mime: string } {
    const row = this.db.prepare("SELECT path, name, mime FROM attachments WHERE id = ? AND task_id = ?").get(id, taskId) as { path: string; name: string; mime: string } | undefined;
    if (!row) throw new NotFoundError(`attachment ${id} not found`);
    return row;
  }

  remove(taskId: number, id: number): void {
    const { path } = this.file(taskId, id);
    rmSync(path, { force: true });
    this.db.prepare("DELETE FROM attachments WHERE id = ?").run(id);
  }

  /** Absolute paths of a task's files, for the agent's prompt. */
  paths(taskId: number): { path: string; name: string; mime: string }[] {
    return this.db.prepare("SELECT path, name, mime FROM attachments WHERE task_id = ? AND kind = 'upload' ORDER BY id").all(taskId) as { path: string; name: string; mime: string }[];
  }
}
