import { MergeError } from "../src/core/git.js";
import { InsightService } from "../src/core/insights.js";
import { SettingsService } from "../src/core/settings.js";
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
    revert: async (id: number) => tasks.setReverted(id, true),
    unrevert: async (id: number) => tasks.setReverted(id, false),
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
    ["POST", "/chat", "M11"],
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

describe("merge failures, stash and revert", () => {
  const post = (app: ReturnType<typeof setup>["app"], url: string, payload: unknown) =>
    app.inject({ method: "POST", url, headers: auth, payload: payload as object });

  it("tells the app why a merge failed and passes the stash choice to the driver", async () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO projects (name, repo_path) VALUES ('p', '/r')").run();
    db.prepare("INSERT INTO tasks (project_id, description) VALUES (1, 'first')").run();
    const base = services(db);
    const seen: unknown[] = [];
    const driver = {
      ...base.driver,
      resolveApproval: async (_id: number, _approve: boolean, _note?: string, opts?: { stash?: boolean }) => {
        seen.push(opts);
        if (!opts?.stash) throw new MergeError("יש שינויים שלא נשמרו", "dirty");
        return { id: 1, warning: "kept" } as never;
      },
    };
    const app = buildApp({ db, accessToken: TOKEN, ...base, driver });
    const failed = await post(app, "/approvals/1", { decision: "approve" });
    expect(failed.statusCode).toBe(409);
    expect(failed.json()).toMatchObject({ error: "merge_failed", reason: "dirty", message: "יש שינויים שלא נשמרו" });
    const ok = await post(app, "/approvals/1", { decision: "approve", stash: true });
    expect(ok.json()).toMatchObject({ warning: "kept" });
    expect(seen).toEqual([{ stash: undefined }, { stash: true }]);
  });

  it("reverts and unreverts a merged task through the API, and refuses other states", async () => {
    const { db, app } = setup();
    expect((await post(app, "/tasks/1/revert", {})).statusCode).toBe(409); // not merged yet
    db.prepare("UPDATE tasks SET status = 'merged' WHERE id = 1").run();
    const reverted = await post(app, "/tasks/1/revert", {});
    expect(reverted.json()).toMatchObject({ status: "merged", reverted_at: expect.any(String) });
    expect((await post(app, "/tasks/1/unrevert", {})).json().reverted_at).toBeNull();
    expect((await post(app, "/tasks/abc/revert", {})).statusCode).toBe(400);
  });
});

describe("follow-up tasks", () => {
  it("continues a merged task with a new task and refuses anything else", async () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO projects (name, repo_path) VALUES ('p', '/r')").run();
    db.prepare("INSERT INTO tasks (project_id, description) VALUES (1, 'first')").run();
    const base = services(db);
    const app = buildApp({ db, accessToken: TOKEN, ...base });
    const send = (url: string, payload: object) => app.inject({ method: "POST", url, headers: auth, payload });

    expect((await send("/tasks/1/followup", { note: "fix it" })).statusCode).toBe(409); // not merged
    db.prepare("UPDATE tasks SET status = 'merged' WHERE id = 1").run();
    expect((await send("/tasks/1/followup", { note: "  " })).statusCode).toBe(400);
    const res = await send("/tasks/1/followup", { note: "the title is cut off" });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ parent_task_id: 1, description: "the title is cut off", project_id: 1 });
    expect(base.started).toEqual([res.json().id]);
    expect((await send("/tasks/99/followup", { note: "x" })).statusCode).toBe(404);
  });
});

describe("plan review option", () => {
  it("stores the choice on the task and tells plan approvals from work approvals", async () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO projects (name, repo_path) VALUES ('p', '/r')").run();
    const base = services(db);
    const app = buildApp({ db, accessToken: TOKEN, ...base });
    const send = (method: "GET" | "POST", url: string, payload?: object) => app.inject({ method, url, headers: auth, payload });
    const asked = (await send("POST", "/tasks", { project_id: 1, description: "a", review_plan: true })).json();
    const plain = (await send("POST", "/tasks", { project_id: 1, description: "b" })).json();
    expect([asked.review_plan, plain.review_plan]).toEqual([1, 0]);
    base.tasks.transition(asked.id, "planning");
    base.approvals.request(asked.id, "plan text", new Date(), "plan");
    expect((await send("GET", "/approvals")).json()).toMatchObject([{ task_id: asked.id, kind: "plan" }]);
    expect((await send("POST", "/tasks", { project_id: 1, description: "c", review_plan: "yes" })).statusCode).toBe(400);
  });
});

describe("scheduled tasks", () => {
  it("creates a night task without starting it, and starting it by hand skips the wait", async () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO projects (name, repo_path) VALUES ('p', '/r')").run();
    const base = services(db);
    const app = buildApp({ db, accessToken: TOKEN, ...base, nightHour: 3 });
    const send = (method: "GET" | "POST", url: string, payload?: object) => app.inject({ method, url, headers: auth, payload });

    expect((await send("GET", "/settings")).json()).toMatchObject({ night_hour: 3 });
    const night = (await send("POST", "/tasks", { project_id: 1, description: "tonight", when: "night" })).json();
    expect(night.scheduled_for).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
    expect(base.started).toEqual([]);
    expect((await send("GET", `/tasks/${night.id}`)).json().scheduled_for).toBe(night.scheduled_for);

    const started = await send("POST", `/tasks/${night.id}/start`, {});
    expect(started.json().scheduled_for).toBeNull();
    expect(base.started).toEqual([night.id]);

    const now = (await send("POST", "/tasks", { project_id: 1, description: "now", when: "now" })).json();
    expect(now.scheduled_for).toBeNull();
    expect(base.started).toEqual([night.id, now.id]);
    expect((await send("POST", "/tasks", { project_id: 1, description: "x", when: "later" })).statusCode).toBe(400);
  });
});

describe("model and changes of a task", () => {
  it("reports the builder's model on the task and serves the stored file summary", async () => {
    const { db, app } = setup();
    const get = (url: string) => app.inject({ method: "GET", url, headers: auth });
    expect((await get("/tasks/1")).json().ai).toBeNull();
    const call = db.prepare("INSERT INTO llm_calls (task_id, agent, model) VALUES (1, ?, ?)");
    call.run("builder", "sonnet");
    call.run("planner", "haiku"); // newer, but the builder's model is the one shown
    expect((await get("/tasks/1")).json().ai).toBe("sonnet");
    call.run("builder", "opus"); // escalation
    expect((await get("/tasks")).json()[0].ai).toBe("opus");

    expect((await get("/tasks/1/changes")).json()).toEqual([]);
    db.prepare("INSERT INTO steps (task_id, agent, status, summary, handoff) VALUES (1, 'system', 'files_changed', '1 קבצים', ?)").run(JSON.stringify([{ path: "a.txt", status: "added", added: 2, removed: 0 }]));
    expect((await get("/tasks/1/changes")).json()).toEqual([{ path: "a.txt", status: "added", added: 2, removed: 0 }]);
    expect((await get("/tasks/99/changes")).statusCode).toBe(404);
  });
});

describe("insights and settings", () => {
  it("lists, applies and unapplies suggestions, and keeps the stash switch", async () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO projects (name, repo_path) VALUES ('p', '/r')").run();
    const settings = new SettingsService(db);
    const app = buildApp({ db, accessToken: TOKEN, ...services(db), settings, insights: new InsightService(db, settings) });
    const send = (method: "GET" | "POST" | "PUT", url: string, payload?: object) => app.inject({ method, url, headers: auth, payload });

    expect((await send("GET", "/insights")).json()).toEqual([]);
    expect((await send("POST", "/insights/nope/apply")).statusCode).toBe(404);
    const applied = await send("POST", "/insights/auto_stash/apply");
    expect(applied.json()).toMatchObject([{ id: "auto_stash", applied: true }]);
    expect((await send("GET", "/settings")).json()).toMatchObject({ auto_stash: true });
    expect((await send("POST", "/insights/auto_stash/unapply")).json()).toEqual([]);
    expect((await send("PUT", "/settings", { auto_stash: true })).json()).toMatchObject({ auto_stash: true });
    expect((await send("PUT", "/settings", { auto_stash: "yes" })).statusCode).toBe(400);
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
