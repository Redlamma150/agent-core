import { networkInterfaces } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp, startServers } from "../src/api/server.js";
import { EventBus } from "../src/api/events.js";
import { openDb } from "../src/db/index.js";
import { ApprovalService } from "../src/core/approvals.js";
import { TaskService } from "../src/core/tasks.js";
import { PushService } from "../src/api/push.js";

export function services(db: ReturnType<typeof openDb>, bus?: EventBus) {
  const tasks = new TaskService(db, bus);
  const approvals = new ApprovalService(db, tasks, { reminderMinutes: 10, reminderCount: 2 }, bus);
  // Stand-in for the pipeline: the API tests care about HTTP behaviour, not about running agents.
  const started: number[] = [];
  const driver = {
    start: (id: number) => void started.push(id),
    stop: (id: number) => tasks.stop(id),
    continueTask: (id: number, _note?: string) => tasks.transition(id, "planning"),
    duplicate: (id: number) => {
      const t = tasks.get(id);
      const copy = tasks.create(t.project_id, t.description);
      started.push(copy.id);
      return copy;
    },
    resolveApproval: async (id: number, approve: boolean, note?: string) => approvals.resolve(id, approve, note),
    locate: (_id: number) => ({ path: "/r", kind: "project" as const, exists: true }),
  };
  return {
    tasks,
    approvals,
    driver,
    started,
    push: new PushService(db, async () => {}, () => {}),
    vapidPublicKey: "PUBKEY",
  };
}

const TOKEN = "t".repeat(40);
const auth = { authorization: `Bearer ${TOKEN}` };

function setup() {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO projects (name, repo_path) VALUES ('p', '/r')").run();
  db.prepare("INSERT INTO tasks (project_id, description) VALUES (1, 'first')").run();
  return { db, app: buildApp({ db, accessToken: TOKEN, ...services(db) }) };
}

describe("auth", () => {
  it("answers with a valid token", async () => {
    const { app } = setup();
    const res = await app.inject({ method: "GET", url: "/tasks", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(1);
  });

  it.each([
    ["no header", {}],
    ["wrong token", { authorization: `Bearer ${"x".repeat(40)}` }],
    ["wrong scheme", { authorization: TOKEN }],
  ])("rejects %s with 401 on every route", async (_name, headers) => {
    const { app } = setup();
    for (const [method, url] of [["GET", "/tasks"], ["POST", "/tasks"], ["GET", "/usage"], ["GET", "/events"], ["POST", "/chat"]] as const) {
      const res = await app.inject({ method, url, headers });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it("gives unknown paths a plain 404 that reveals nothing", async () => {
    const { app } = setup();
    expect((await app.inject({ method: "GET", url: "/nope" })).statusCode).toBe(404);
  });
});

describe("routes", () => {
  it("returns a task, 404 and 400", async () => {
    const { app } = setup();
    expect((await app.inject({ url: "/tasks/1", headers: auth })).json()).toMatchObject({ id: 1, status: "received" });
    expect((await app.inject({ url: "/tasks/9", headers: auth })).statusCode).toBe(404);
    expect((await app.inject({ url: "/tasks/abc", headers: auth })).statusCode).toBe(400);
  });

  it("reports usage and pending approvals", async () => {
    const { app } = setup();
    expect((await app.inject({ url: "/usage", headers: auth })).json()).toMatchObject({ calls: 0, input_tokens: 0, output_tokens: 0, last_5h: { calls: 0 }, top_tasks: [] });
    expect((await app.inject({ url: "/approvals", headers: auth })).json()).toEqual([]);
  });

  it.each([
    ["GET", "/projects/active", "M6"],
    ["POST", "/projects/active", "M6"],
    ["POST", "/chat", "M5"],
  ] as const)("%s %s returns 501", async (method, url, milestone) => {
    const { app } = setup();
    const res = await app.inject({ method, url, headers: auth });
    expect(res.statusCode).toBe(501);
    expect(res.json()).toEqual({ error: "not_implemented", milestone });
  });
});

describe("task and approval routes", () => {
  const post = (app: ReturnType<typeof setup>["app"], url: string, payload: unknown) =>
    app.inject({ method: "POST", url, headers: auth, payload: payload as object });

  it("creates a task, stops it, and refuses to stop it twice", async () => {
    const { app } = setup();
    const created = await post(app, "/tasks", { project_id: 1, description: "do it" });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    expect((await post(app, `/tasks/${id}/stop`, {})).json()).toMatchObject({ id, status: "stopped" });
    expect((await post(app, `/tasks/${id}/stop`, {})).statusCode).toBe(409);
    expect((await post(app, "/tasks/999/stop", {})).statusCode).toBe(404);
  });

  it("stores the flagged marker for escalation", async () => {
    const { app } = setup();
    const created = await post(app, "/tasks", { project_id: 1, description: "touches auth", flagged: true });
    expect(created.json()).toMatchObject({ flagged: 1 });
    expect((await post(app, "/tasks", { project_id: 1, description: "x", flagged: "yes" })).statusCode).toBe(400);
  });

  it("validates the create body and the project", async () => {
    const { app } = setup();
    expect((await post(app, "/tasks", { description: "x" })).statusCode).toBe(400);
    expect((await post(app, "/tasks", { project_id: 1, description: "  " })).statusCode).toBe(400);
    expect((await post(app, "/tasks", { project_id: 42, description: "x" })).statusCode).toBe(404);
  });

  it("approves and rejects through /approvals/:id", async () => {
    const { db, app } = setup();
    const { tasks, approvals } = services(db);
    tasks.transition(1, "planning");
    const a = approvals.request(1, "merge?");
    expect((await app.inject({ url: "/approvals", headers: auth })).json()).toHaveLength(1);

    expect((await post(app, `/approvals/${a.id}`, { decision: "maybe" })).statusCode).toBe(400);
    const rejected = await post(app, `/approvals/${a.id}`, { decision: "reject", note: "again" });
    expect(rejected.json()).toMatchObject({ status: "rejected", notes: "again" });
    expect((await post(app, `/approvals/${a.id}`, { decision: "approve" })).statusCode).toBe(409);
    expect((await post(app, "/approvals/999", { decision: "approve" })).statusCode).toBe(404);
  });
});

describe("listening", () => {
  let servers: Awaited<ReturnType<typeof startServers>> = [];
  afterEach(async () => {
    await Promise.all(servers.map((s) => s.close()));
    servers = [];
  });

  it("serves SSE events over a real socket", async () => {
    const bus = new EventBus();
    let db: ReturnType<typeof openDb>;
    servers = await startServers({ db: (db = openDb(":memory:")), accessToken: TOKEN, ...services(db, bus), bus }, ["127.0.0.1"], 0);
    const addr = servers[0]!.server.address() as { port: number };
    const res = await fetch(`http://127.0.0.1:${addr.port}/events`, { headers: auth });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const reader = res.body!.getReader();
    await reader.read(); // ": connected"
    bus.publish({ type: "task", data: { id: 1, status: "planning" } });
    const chunk = new TextDecoder().decode((await reader.read()).value);
    expect(chunk).toBe('event: task\ndata: {"id":1,"status":"planning"}\n\n');
    await reader.cancel();
  });

  it("ends open event streams when the server closes, after many reconnects", async () => {
    const bus = new EventBus();
    let db: ReturnType<typeof openDb>;
    servers = await startServers({ db: (db = openDb(":memory:")), accessToken: TOKEN, ...services(db, bus), bus }, ["127.0.0.1"], 0);
    const port = (servers[0]!.server.address() as { port: number }).port;
    for (let i = 0; i < 5; i++) {
      const r = await fetch(`http://127.0.0.1:${port}/events`, { headers: auth });
      const rd = r.body!.getReader();
      await rd.read();
      await rd.cancel();
    }
    const res = await fetch(`http://127.0.0.1:${port}/events`, { headers: auth });
    const reader = res.body!.getReader();
    await reader.read();
    await servers[0]!.close();
    expect((await reader.read()).done).toBe(true);
  });

  it("skips an address that does not exist on this computer instead of crashing", async () => {
    const db = openDb(":memory:");
    const warnings: string[] = [];
    // 192.0.2.1 is reserved for documentation: no machine has it, like a Tailscale IP while Tailscale is off.
    servers = await startServers({ db, accessToken: TOKEN, ...services(db) }, ["127.0.0.1", "192.0.2.1"], 0, (l) => warnings.push(l));
    expect(servers).toHaveLength(1);
    expect(warnings[0]).toContain("192.0.2.1");
    await expect(startServers({ db, accessToken: TOKEN, ...services(db) }, ["192.0.2.1"], 0, () => {})).rejects.toThrow(/none of the addresses/);
  });

  it("does not answer on an address outside the bind list", async () => {
    const db = openDb(":memory:");
    servers = await startServers({ db, accessToken: TOKEN, ...services(db) }, ["127.0.0.1"], 0);
    const port = (servers[0]!.server.address() as { port: number }).port;
    const ok = await fetch(`http://127.0.0.1:${port}/usage`, { headers: auth });
    expect(ok.status).toBe(200);

    const lan = Object.values(networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal);
    if (!lan) return; // no non-loopback interface to probe on this machine
    await expect(fetch(`http://${lan.address}:${port}/usage`, { headers: auth })).rejects.toThrow();
  });
});
