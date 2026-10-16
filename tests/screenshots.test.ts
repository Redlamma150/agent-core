import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it } from "vitest";
import { MediaService } from "../src/core/media.js";
import { findEntry, playwrightLauncher, ScreenshotService, serveFolder, type LaunchShooter } from "../src/core/screenshots.js";
import { openDb } from "../src/db/index.js";
import { makeRepo } from "./repo-helper.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "shot-test-"));
  dirs.push(d);
  return d;
};
const write = (root: string, rel: string, text: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};

describe("findEntry", () => {
  it("prefers the shallowest html file the task changed", () => {
    const root = tmp();
    write(root, "index.html", "x");
    write(root, "chess/index.html", "x");
    expect(findEntry(root, ["chess/index.html", "chess/app.js", "index.html"])).toBe("index.html");
    expect(findEntry(root, ["chess/index.html"])).toBe("chess/index.html");
  });
  it("falls back to an index.html in the usual folders, and returns null when there is none", () => {
    const root = tmp();
    expect(findEntry(root, ["notes.md"])).toBeNull();
    write(root, "public/index.html", "x");
    expect(findEntry(root, ["notes.md"])).toBe("public/index.html");
  });
  it("ignores a changed html file that no longer exists (deleted)", () => {
    expect(findEntry(tmp(), ["gone.html"])).toBeNull();
  });
});

describe("serveFolder", () => {
  it("serves files read only on localhost and refuses paths outside the folder", async () => {
    const root = tmp();
    write(root, "site/index.html", "<h1>hi</h1>");
    write(root, "secret.txt", "no");
    const s = await serveFolder(join(root, "site"));
    try {
      expect(s.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const ok = await fetch(`${s.origin}/index.html`);
      expect(ok.status).toBe(200);
      expect(ok.headers.get("content-type")).toContain("text/html");
      expect((await fetch(`${s.origin}/`)).status).toBe(200);
      expect((await fetch(`${s.origin}/missing.css`)).status).toBe(404);
      expect((await fetch(`${s.origin}/..%2fsecret.txt`)).status).not.toBe(200);
      expect((await fetch(`${s.origin}/%2e%2e/secret.txt`)).status).not.toBe(200);
      expect((await fetch(`${s.origin}/x`, { method: "POST", body: "a" })).status).toBeLessThan(500);
    } finally {
      await s.close();
    }
  });
});

describe("ScreenshotService", () => {
  async function setup() {
    const { repo, git } = await makeRepo();
    const db = openDb(":memory:");
    db.prepare("INSERT INTO projects (name, repo_path) VALUES ('proj', ?)").run(repo);
    db.prepare("INSERT INTO tasks (project_id, description) VALUES (1, 'x')").run();
    const media = new MediaService(db, join(tmp(), "uploads"));
    const urls: string[] = [];
    const launch: LaunchShooter = async () => ({
      async shoot(url, viewport) {
        urls.push(`${url}@${viewport.width}`);
        const body = await (await fetch(url)).text(); // proves the page is really being served
        return Buffer.concat([PNG, Buffer.from(body)]);
      },
      close: async () => undefined,
    });
    return { repo, git, db, media, urls, service: new ScreenshotService(media, launch) };
  }

  it("takes before and after at phone and desktop size when the page existed before", async () => {
    const t = await setup();
    write(t.repo, "index.html", "<p>old</p>");
    const g = simpleGit(t.repo);
    await g.add("-A");
    await g.raw(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "page"]);
    const prepared = await t.git.prepare(t.repo, 1);
    write(prepared.worktree, "index.html", "<p>new</p>");

    const out = await t.service.capture(1, { repo: t.repo, base: prepared.base, worktree: prepared.worktree, changedFiles: ["index.html"] });

    expect(out.saved.sort()).toEqual(["after-desktop.png", "after-phone.png", "before-desktop.png", "before-phone.png"]);
    expect(out.summary).toBe("צילומי לפני ואחרי מוכנים");
    const list = t.media.list(1);
    expect(list.every((a) => a.kind === "screenshot" && a.mime === "image/png")).toBe(true);
    const content = (name: string) => readFileSync(t.media.file(1, list.find((a) => a.name === name)!.id).path).toString("latin1");
    expect(content("before-phone.png")).toContain("old");
    expect(content("after-desktop.png")).toContain("new");
    expect(t.urls.filter((u) => u.endsWith("@390")).length).toBe(2);
    expect(t.urls.filter((u) => u.endsWith("@1280")).length).toBe(2);
  });

  it("takes only the after pictures for a brand new page, and replaces older screenshots on a retake", async () => {
    const t = await setup();
    const prepared = await t.git.prepare(t.repo, 1);
    write(prepared.worktree, "index.html", "<p>fresh</p>");
    const input = { repo: t.repo, base: prepared.base, worktree: prepared.worktree, changedFiles: ["index.html"] };

    const first = await t.service.capture(1, input);
    expect(first.saved.sort()).toEqual(["after-desktop.png", "after-phone.png"]);
    expect(first.summary).toContain("אין מצב קודם");
    const firstPath = t.media.file(1, t.media.list(1)[0]!.id).path;

    await t.service.capture(1, input);
    expect(t.media.list(1)).toHaveLength(2);
    expect(existsSync(firstPath)).toBe(false);
  });

  it("does nothing when the project has no static page", async () => {
    const t = await setup();
    const prepared = await t.git.prepare(t.repo, 1);
    const out = await t.service.capture(1, { repo: t.repo, base: prepared.base, worktree: prepared.worktree, changedFiles: ["server.js"] });
    expect(out.saved).toEqual([]);
    expect(t.media.list(1)).toEqual([]);
  });

  it("keeps screenshots out of the agents' file list and out of the owner's 10 file limit", async () => {
    const t = await setup();
    t.media.saveScreenshot(1, "after-phone.png", PNG);
    expect(t.media.paths(1)).toEqual([]);
    for (let i = 0; i < 10; i++) t.media.save(1, `f${i}.txt`, "text/plain", Buffer.from("hi"));
    expect(t.media.list(1)).toHaveLength(11);
    expect(() => t.media.saveScreenshot(1, "bad.png", Buffer.from("nope"))).toThrow();
  });
});

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
describe.skipIf(!existsSync(CHROME))("real browser", () => {
  it("photographs a local page and blocks requests to anything but the local server", async () => {
    const root = tmp();
    write(root, "index.html", '<!doctype html><body style="background:#2F5BEA"><h1>שלום</h1><img src="http://example.invalid/x.png"></body>');
    const server = await serveFolder(root);
    const shooter = await playwrightLauncher(CHROME)();
    try {
      const phone = await shooter.shoot(`${server.origin}/index.html`, { width: 390, height: 844 });
      expect(phone.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      expect(phone.length).toBeGreaterThan(500);
    } finally {
      await shooter.close();
      await server.close();
    }
  }, 60_000);
});
