import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/api/server.js";
import { isLocalRequest, type LocalActions } from "../src/core/local.js";
import { MAX_FILES_PER_TASK, MediaError, MediaService, matchesContent, safeName } from "../src/core/media.js";
import { openDb } from "../src/db/index.js";
import { services } from "./api.test.js";

const TOKEN = "t".repeat(40);
const auth = { authorization: `Bearer ${TOKEN}` };
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);

function setup() {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO projects (name, repo_path) VALUES ('p', ?)").run(tmpdir());
  db.prepare("INSERT INTO tasks (project_id, description) VALUES (1, 'first')").run();
  const media = new MediaService(db, mkdtempSync(join(tmpdir(), "uploads-")));
  const opened: { path: string; target: string }[] = [];
  const local: LocalActions = { open: async (path, target) => void opened.push({ path, target }), pickFolder: async () => "/picked" };
  const app = buildApp({ db, accessToken: TOKEN, ...services(db), media, local });
  return { db, media, app, opened };
}

describe("media rules", () => {
  it("cleans file names and keeps Hebrew", () => {
    expect(safeName("../../etc/passwd", "text/plain")).toBe("passwd.txt");
    expect(safeName("צילום מסך.png", "image/png")).toBe("צילום מסך.png");
    expect(safeName("a<b>|c.jpg", "image/jpeg")).toBe("a_b__c.jpg");
    expect(safeName("....", "image/png")).toBe("file.png");
  });
  it("checks that the content matches the type", () => {
    expect(matchesContent("image/png", PNG)).toBe(true);
    expect(matchesContent("image/png", Buffer.from("MZ executable"))).toBe(false);
    expect(matchesContent("application/pdf", Buffer.from("%PDF-1.7 ..."))).toBe(true);
    expect(matchesContent("text/plain", Buffer.from([65, 0, 66]))).toBe(false);
  });
  it("saves a file outside any repo, lists it and refuses bad uploads", () => {
    const { media } = setup();
    const a = media.save(1, "shot.png", "image/png", PNG);
    expect(readFileSync(media.file(1, a.id).path).equals(PNG)).toBe(true);
    expect(media.list(1)).toHaveLength(1);
    expect(() => media.save(1, "x.svg", "image/svg+xml", Buffer.from("<svg/>"))).toThrow(MediaError);
    expect(() => media.save(1, "x.png", "image/png", Buffer.from("not a png"))).toThrow(MediaError);
    expect(() => media.save(1, "x.png", "image/png", Buffer.alloc(0))).toThrow(MediaError);
    expect(() => media.save(1, "x.png", "image/png", Buffer.alloc(16 * 1024 * 1024, 0x89))).toThrow(MediaError);
    for (let i = media.list(1).length; i < MAX_FILES_PER_TASK; i++) media.save(1, `f${i}.png`, "image/png", PNG);
    expect(() => media.save(1, "extra.png", "image/png", PNG)).toThrow(/עד 10/);
  });
});

describe("media API", () => {
  it("uploads, lists, serves back safely and deletes", async () => {
    const { app } = setup();
    const up = await app.inject({ method: "POST", url: "/tasks/1/media?name=" + encodeURIComponent("תמונה.png"), headers: { ...auth, "content-type": "image/png" }, payload: PNG });
    expect(up.statusCode).toBe(201);
    const { id } = up.json() as { id: number };
    expect((await app.inject({ url: "/tasks/1/media", headers: auth })).json()).toHaveLength(1);
    const got = await app.inject({ url: `/tasks/1/media/${id}`, headers: auth });
    expect(got.statusCode).toBe(200);
    expect(got.headers["content-type"]).toBe("image/png");
    expect(got.headers["x-content-type-options"]).toBe("nosniff");
    expect(got.headers["content-security-policy"]).toBe("sandbox");
    expect(got.rawPayload.equals(PNG)).toBe(true);
    expect((await app.inject({ method: "DELETE", url: `/tasks/1/media/${id}`, headers: auth })).statusCode).toBe(204);
    expect((await app.inject({ url: `/tasks/1/media/${id}`, headers: auth })).statusCode).toBe(404);
  });
  it("needs the token, rejects wrong types and unknown tasks", async () => {
    const { app } = setup();
    expect((await app.inject({ method: "POST", url: "/tasks/1/media?name=a.png", headers: { "content-type": "image/png" }, payload: PNG })).statusCode).toBe(401);
    const svg = await app.inject({ method: "POST", url: "/tasks/1/media?name=a.svg", headers: { ...auth, "content-type": "image/svg+xml" }, payload: "<svg/>" });
    expect(svg.statusCode).toBe(415);
    const fake = await app.inject({ method: "POST", url: "/tasks/1/media?name=a.png", headers: { ...auth, "content-type": "image/png" }, payload: Buffer.from("hello") });
    expect(fake.statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/tasks/99/media?name=a.png", headers: { ...auth, "content-type": "image/png" }, payload: PNG })).statusCode).toBe(404);
  });
});

describe("local-only actions", () => {
  const phone = { "x-forwarded-for": "100.64.0.9" };
  it("recognises requests from this computer, not the ones relayed by tailscale serve", () => {
    expect(isLocalRequest({ ip: "127.0.0.1", headers: {} })).toBe(true);
    expect(isLocalRequest({ ip: "127.0.0.1", headers: phone })).toBe(false);
    expect(isLocalRequest({ ip: "127.0.0.1", headers: { "tailscale-user-login": "me@x" } })).toBe(false);
    expect(isLocalRequest({ ip: "100.64.0.9", headers: {} })).toBe(false);
  });
  it("opens the task folder from the computer and refuses from the phone", async () => {
    const { app, opened } = setup();
    expect((await app.inject({ method: "POST", url: "/tasks/1/open", headers: auth, payload: { target: "editor" }, remoteAddress: "127.0.0.1" })).statusCode).toBe(204);
    expect(opened).toEqual([{ path: "/r", target: "editor" }]);
    const remote = await app.inject({ method: "POST", url: "/tasks/1/open", headers: { ...auth, ...phone }, payload: { target: "folder" }, remoteAddress: "127.0.0.1" });
    expect(remote.statusCode).toBe(403);
    expect(opened).toHaveLength(1);
  });
  it("tells where a task lives, to everyone with the token", async () => {
    const { app } = setup();
    expect((await app.inject({ url: "/tasks/1/location", headers: { ...auth, ...phone } })).json()).toEqual({ path: "/r", kind: "project", exists: true });
  });
  it("registers a project by path and picks a folder, local only", async () => {
    const { app } = setup();
    const repo = mkdtempSync(join(tmpdir(), "repo-"));
    mkdirSync(repo, { recursive: true });
    const git = simpleGit(repo);
    await git.init();
    writeFileSync(join(repo, "a"), "x");
    await git.add(".");
    await git.raw(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "i"]);
    const ok = await app.inject({ method: "POST", url: "/projects", headers: auth, payload: { path: repo }, remoteAddress: "127.0.0.1" });
    expect(ok.statusCode).toBe(201);
    expect((await app.inject({ url: "/projects", headers: auth })).json()).toContainEqual(expect.objectContaining({ repo_path: repo }));
    const bad = await app.inject({ method: "POST", url: "/projects", headers: auth, payload: { path: "relative/dir" }, remoteAddress: "127.0.0.1" });
    expect(bad.statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/projects", headers: { ...auth, ...phone }, payload: { path: repo }, remoteAddress: "127.0.0.1" })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/projects/pick", headers: auth, remoteAddress: "127.0.0.1" })).json()).toEqual({ path: "/picked" });
    expect((await app.inject({ method: "POST", url: "/projects/pick", headers: { ...auth, ...phone }, remoteAddress: "127.0.0.1" })).statusCode).toBe(403);
  });
});
