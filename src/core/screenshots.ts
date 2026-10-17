import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, posix, resolve, sep } from "node:path";
import type { MediaService } from "./media.js";

export const VIEWPORTS = { phone: { width: 390, height: 844 }, desktop: { width: 1280, height: 800 } } as const;
export type Device = keyof typeof VIEWPORTS;
export type Moment = "before" | "after";

/** A browser that can take one screenshot of a page. Injected, so tests run without a real browser. */
export interface Shooter {
  shoot(url: string, viewport: { width: number; height: number }): Promise<Buffer>;
  close(): Promise<void>;
}
export type LaunchShooter = () => Promise<Shooter>;

export const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".txt": "text/plain", ".md": "text/plain",
};

/** Maps a request path to a file inside `base`: 400 for a bad path, 403 for one that leaves the folder, 404 for a missing file. */
export function resolveStatic(base: string, url: string): { status: 200; file: string } | { status: 400 | 403 | 404 } {
  let path: string;
  try {
    path = decodeURIComponent(new URL(url, "http://x").pathname);
  } catch {
    return { status: 400 };
  }
  let file = resolve(base, "." + posix.normalize("/" + path));
  if (file !== base && !file.startsWith(base + sep)) return { status: 403 };
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
  if (!existsSync(file) || !statSync(file).isFile()) return { status: 404 };
  return { status: 200, file };
}

/** Serves one folder on a random localhost port, read only, so a built page can be opened in the browser. */
export async function serveFolder(root: string): Promise<{ origin: string; close: () => Promise<void> }> {
  const base = resolve(root);
  const server: Server = createServer((req, res) => {
    const found = resolveStatic(base, req.url ?? "/");
    if (found.status !== 200) {
      res.writeHead(found.status).end();
      return;
    }
    res.writeHead(200, { "content-type": MIME[extname(found.file).toLowerCase()] ?? "application/octet-stream", "cache-control": "no-store" });
    res.end(readFileSync(found.file));
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const { port } = server.address() as { port: number };
  return { origin: `http://127.0.0.1:${port}`, close: () => new Promise<void>((ok) => server.close(() => ok())) };
}

const FALLBACK_DIRS = ["", "public", "docs", "dist", "build", "src"];

/**
 * Which page to photograph: the shallowest .html file the task changed, otherwise an index.html in the usual places.
 * Returns a path relative to the project root, or null when the project has no static page to show.
 */
export function findEntry(root: string, changedFiles: string[]): string | null {
  const html = changedFiles.filter((f) => /\.html?$/i.test(f)).sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
  if (html[0] && existsSync(join(root, html[0]))) return html[0];
  for (const dir of FALLBACK_DIRS) {
    const candidate = posix.join(dir, "index.html");
    if (existsSync(join(root, candidate))) return candidate;
  }
  return null;
}

/** Copies a branch's files (as committed) into a folder, without touching any checkout. */
async function exportTree(repo: string, ref: string, dest: string): Promise<void> {
  mkdirSync(dest, { recursive: true });
  await new Promise<void>((ok, fail) => {
    const archive = spawn("git", ["-C", repo, "archive", "--format=tar", ref], { stdio: ["ignore", "pipe", "pipe"] });
    const untar = spawn("tar", ["-x", "-C", dest], { stdio: ["pipe", "ignore", "pipe"] });
    archive.stdout.pipe(untar.stdin);
    let err = "";
    archive.stderr.on("data", (d: Buffer) => (err += d));
    untar.stderr.on("data", (d: Buffer) => (err += d));
    archive.on("error", fail);
    untar.on("error", fail);
    untar.on("close", (code) => (code === 0 ? ok() : fail(new Error(`could not export ${ref}: ${err.trim().slice(0, 200)}`))));
  });
}

export interface CaptureInput {
  repo: string;
  base: string;
  worktree: string;
  changedFiles: string[];
}
export interface CaptureResult {
  /** File names saved, like "after-phone.png". */
  saved: string[];
  /** One line for the owner, in Hebrew. */
  summary: string;
}

/**
 * Photographs a task's page before and after the change, at phone and desktop size, and stores the PNGs with the task.
 * Only static pages are supported: the folder is served read only on localhost and every other network request is blocked.
 */
export class ScreenshotService {
  constructor(private media: MediaService, private launch: LaunchShooter) {}

  async capture(taskId: number, input: CaptureInput): Promise<CaptureResult> {
    const entry = findEntry(input.worktree, input.changedFiles);
    if (!entry) return { saved: [], summary: "לא נמצא עמוד להצגה, ולכן אין צילומים" };
    const scratch = mkdtempSync(join(tmpdir(), "shots-"));
    const closers: (() => Promise<void>)[] = [];
    try {
      const beforeDir = join(scratch, "before");
      await exportTree(input.repo, input.base, beforeDir);
      const jobs: { moment: Moment; root: string; present: boolean }[] = [
        { moment: "before", root: beforeDir, present: existsSync(join(beforeDir, entry)) },
        { moment: "after", root: input.worktree, present: true },
      ];
      const shooter = await this.launch();
      closers.push(() => shooter.close());
      this.media.removeScreenshots(taskId);
      const saved: string[] = [];
      for (const job of jobs) {
        if (!job.present) continue; // a new page has no "before"
        const dir = join(job.root, dirname(entry));
        const server = await serveFolder(dir);
        closers.push(server.close);
        const page = `${server.origin}/${posix.basename(entry)}`;
        for (const device of Object.keys(VIEWPORTS) as Device[]) {
          const png = await shooter.shoot(page, VIEWPORTS[device]);
          saved.push(this.media.saveScreenshot(taskId, `${job.moment}-${device}.png`, png).name);
        }
      }
      return { saved, summary: saved.some((n) => n.startsWith("before-")) ? "צילומי לפני ואחרי מוכנים" : "צילומי העמוד החדש מוכנים (אין מצב קודם להשוואה)" };
    } finally {
      for (const close of closers.reverse()) await close().catch(() => undefined);
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}

/** The real browser: Playwright driving the Chrome that is installed on this computer (nothing is downloaded). */
export function playwrightLauncher(executablePath?: string): LaunchShooter {
  return async () => {
    const { chromium } = await import("playwright-core");
    const browser = await chromium.launch(executablePath ? { executablePath } : { channel: "chrome" });
    return {
      async shoot(url, viewport) {
        const context = await browser.newContext({ viewport, deviceScaleFactor: 1, serviceWorkers: "block" });
        try {
          const origin = new URL(url).origin;
          // The page was written by an agent: it may only talk to the local folder server, never to the internet.
          await context.route("**/*", (route) => (route.request().url().startsWith(origin) ? route.continue() : route.abort()));
          const page = await context.newPage();
          await page.goto(url, { waitUntil: "load", timeout: 20_000 });
          await page.waitForTimeout(400);
          return await page.screenshot({ type: "png" });
        } finally {
          await context.close();
        }
      },
      close: () => browser.close(),
    };
  };
}
