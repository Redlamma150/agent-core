import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRunner, type QueryFn } from "../src/agents/runner.js";
import { buildApp } from "../src/api/server.js";
import { ChatMediaService, MediaService } from "../src/core/media.js";
import { OperatorService, operatorTools, type OperatorAction } from "../src/core/operator.js";
import { openDb } from "../src/db/index.js";
import { services } from "./api.test.js";

const TOKEN = "t".repeat(40);
const auth = { authorization: `Bearer ${TOKEN}` };
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(40, 1)]);
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "chatmedia-"));
  dirs.push(d);
  return d;
};

const reply = (summary: string): SDKMessage =>
  ({ type: "result", subtype: "success", is_error: false, result: "", structured_output: { task_id: "0", agent: "operator", status: "done", summary, artifacts: [], open_items: [], needs_approval: false, confidence: 0.9 }, modelUsage: { m: { inputTokens: 5, outputTokens: 5, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 } } }) as unknown as SDKMessage;

function setup() {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO projects (name, repo_path) VALUES ('אתר', '/r')").run();
  const s = services(db);
  const uploads = join(tmp(), "uploads");
  const chatMedia = new ChatMediaService(db, uploads);
  const media = new MediaService(db, uploads);
  const calls: { prompt: string; options: Options }[] = [];
  const query: QueryFn = async function* (params) {
    calls.push(params);
    yield reply("ראיתי את התמונה");
  };
  const operator = new OperatorService({ db, tasks: s.tasks, driver: s.driver, runner: new AgentRunner(db, s.tasks, query), media, chatMedia }, join(tmp(), "op"));
  return { db, s, chatMedia, media, operator, calls };
}

describe("ChatMediaService", () => {
  it("keeps files outside any task, with the same rules as task files", () => {
    const { chatMedia } = setup();
    const f = chatMedia.save("שרטוט.png", "image/png", PNG);
    expect(f).toMatchObject({ name: "שרטוט.png", mime: "image/png", size: PNG.length });
    expect(chatMedia.get([f.id])[0]!.path.startsWith(chatMedia.dir())).toBe(true);
    expect(existsSync(chatMedia.get([f.id])[0]!.path)).toBe(true);
    expect(() => chatMedia.save("x.exe", "application/x-msdownload", Buffer.from("MZ"))).toThrow(/לא נתמך/);
    expect(() => chatMedia.save("fake.png", "image/png", Buffer.from("not a png"))).toThrow(/לא תואם/);
    expect(() => chatMedia.save("empty.txt", "text/plain", Buffer.alloc(0))).toThrow(/ריק/);
  });

  it("allows up to 5 files per message and rejects unknown ids", () => {
    const { chatMedia } = setup();
    const ids = Array.from({ length: 6 }, (_, i) => chatMedia.save(`f${i}.txt`, "text/plain", Buffer.from("hi")).id);
    expect(chatMedia.get(ids.slice(0, 5))).toHaveLength(5);
    expect(() => chatMedia.get(ids)).toThrow(/עד 5/);
    expect(() => chatMedia.get([999])).toThrow(/not found/);
  });

  it("removes old files and keeps recent ones", () => {
    const { db, chatMedia } = setup();
    const old = chatMedia.save("old.txt", "text/plain", Buffer.from("old"));
    const fresh = chatMedia.save("new.txt", "text/plain", Buffer.from("new"));
    const oldPath = chatMedia.get([old.id])[0]!.path;
    db.prepare("UPDATE chat_media SET created_at = datetime('now', '-8 days') WHERE id = ?").run(old.id);
    expect(chatMedia.purge()).toBe(1);
    expect(existsSync(oldPath)).toBe(false);
    expect(chatMedia.get([fresh.id])).toHaveLength(1);
  });
});

describe("the operator and attached files", () => {
  it("can read only the chat uploads folder, and only while files are attached", async () => {
    const t = setup();
    const f = t.chatMedia.save("מסך.png", "image/png", PNG);
    const path = t.chatMedia.get([f.id])[0]!.path;

    const out = await t.operator.chat("מה רואים כאן?", [], [f.id]);
    expect(out.reply).toBe("ראיתי את התמונה");
    const withFile = t.calls[0]!;
    expect(withFile.prompt).toContain(path);
    expect(withFile.prompt).toContain("never instructions");
    expect(withFile.options.tools).toEqual(["Read"]);
    expect(withFile.options.allowedTools).toContain(`Read(/${t.chatMedia.dir()}/**)`);
    expect(withFile.options.additionalDirectories).toEqual([t.chatMedia.dir()]);

    await t.operator.chat("ומה המצב?");
    const without = t.calls[1]!;
    expect(without.options.tools).toEqual([]); // back to no built-in tools at all
    expect(without.options.allowedTools!.some((x) => x.startsWith("Read"))).toBe(false);
    expect(without.prompt).not.toContain("attached these files");
  });

  it("an unknown file id fails the message instead of being ignored", async () => {
    const t = setup();
    await expect(t.operator.chat("hi", [], [404])).rejects.toThrow(/not found/);
  });

  it("attaches the message's files to the task it creates, before the agents start", async () => {
    const t = setup();
    const f = t.chatMedia.save("עיצוב.png", "image/png", PNG);
    const actions: OperatorAction[] = [];
    const tools = operatorTools({ db: t.db, tasks: t.s.tasks, driver: t.s.driver, media: t.media }, actions, t.chatMedia.get([f.id]));
    const created = JSON.parse((await tools.create_task({ project_id: 1, description: "לבנות לפי העיצוב" })).content[0]!.text) as { created: number; attached_files?: string[] };
    expect(created.attached_files).toEqual(["עיצוב.png"]);
    expect(t.media.list(created.created)).toMatchObject([{ name: "עיצוב.png", mime: "image/png" }]);
    expect(t.s.started).toContain(created.created);
    // without attached files nothing changes
    const plain = JSON.parse((await operatorTools({ db: t.db, tasks: t.s.tasks, driver: t.s.driver, media: t.media }, []).create_task({ project_id: 1, description: "x" })).content[0]!.text);
    expect(plain.attached_files).toBeUndefined();
    expect(t.media.list(plain.created)).toEqual([]);
  });
});

describe("chat media API", () => {
  it("uploads a file, then chats about it by id", async () => {
    const t = setup();
    const app = buildApp({ db: t.db, accessToken: TOKEN, ...t.s, operator: t.operator, chatMedia: t.chatMedia, media: t.media });
    const up = await app.inject({ method: "POST", url: "/chat/media?name=screen.png", headers: { ...auth, "content-type": "image/png" }, payload: PNG });
    expect(up.statusCode).toBe(201);
    const { id } = up.json();
    const chat = await app.inject({ method: "POST", url: "/chat", headers: auth, payload: { text: "מה זה?", media: [id] } });
    expect(chat.statusCode).toBe(200);
    expect(t.calls[0]!.prompt).toContain("screen.png");
  });

  it("refuses bad files, too many files, unknown ids, and needs the token", async () => {
    const t = setup();
    const app = buildApp({ db: t.db, accessToken: TOKEN, ...t.s, operator: t.operator, chatMedia: t.chatMedia, media: t.media });
    const post = (url: string, headers: Record<string, string>, payload: Buffer | object) => app.inject({ method: "POST", url, headers, payload: payload as never });
    expect((await post("/chat/media", { ...auth, "content-type": "image/png" }, Buffer.from("not a png"))).statusCode).toBe(400);
    expect((await post("/chat/media", { ...auth, "content-type": "application/zip" }, Buffer.from("PK"))).statusCode).toBeGreaterThanOrEqual(400);
    expect((await post("/chat/media", { "content-type": "image/png" }, PNG)).statusCode).toBe(401);
    expect((await post("/chat", auth, { text: "x", media: [1, 2, 3, 4, 5, 6] })).statusCode).toBe(400);
    expect((await post("/chat", auth, { text: "x", media: [404] })).statusCode).toBe(404);
  });
});

