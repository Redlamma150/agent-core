/**
 * M7 acceptance criteria, one test each, run against the real API (HTTP), real git repositories and the real
 * pipeline. Only the Claude Agent SDK is replaced by a scripted fake. Delivery to an actual phone and the
 * tap on the approval button in the PWA are checked by hand (see README).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it } from "vitest";
import { EventBus } from "../src/api/events.js";
import { attachPush, PushService } from "../src/api/push.js";
import { buildApp, startServers } from "../src/api/server.js";
import { handoffSchema } from "../src/agents/contract.js";
import { AgentRunner } from "../src/agents/runner.js";
import { ApprovalService } from "../src/core/approvals.js";
import { BudgetService } from "../src/core/budget.js";
import { Pipeline } from "../src/core/pipeline.js";
import { TaskService } from "../src/core/tasks.js";
import { openDb } from "../src/db/index.js";
import { fakeAgents, handoff, type Behaviour, type Role } from "./fake-agents.js";
import { makeRepo } from "./repo-helper.js";

const TOKEN = "t".repeat(40);
const auth = { authorization: `Bearer ${TOKEN}` };
const json = { ...auth, "content-type": "application/json" };

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((c) => c()));
});

async function boot(opts: { cap?: number; behaviour?: Partial<Record<Role, Behaviour>> } = {}) {
  const { repo, git } = await makeRepo();
  const db = openDb(":memory:");
  db.prepare("INSERT INTO projects (name, repo_path) VALUES ('gigs', ?)").run(repo);
  const bus = new EventBus();
  const tasks = new TaskService(db, bus);
  const approvals = new ApprovalService(db, tasks, { reminderMinutes: 10, reminderCount: 2 }, bus);
  const pushed: { title: string; body: string }[] = [];
  const push = new PushService(db, async (_s, payload) => void pushed.push(JSON.parse(payload)), () => {});
  push.subscribe({ endpoint: "https://push.example/phone", keys: { p256dh: "k", auth: "a" } });
  attachPush(bus, push);
  const agents = fakeAgents(opts.behaviour);
  const budget = new BudgetService(tasks, opts.cap ?? 1_000_000, bus);
  const pipeline = new Pipeline({ db, tasks, approvals, runner: new AgentRunner(db, tasks, agents.query), budget, git }, () => {});
  const logs: string[] = [];
  const logStream = new PassThrough();
  logStream.on("data", (c) => logs.push(String(c)));
  const deps = { db, accessToken: TOKEN, tasks, approvals, driver: pipeline, push, vapidPublicKey: "PUB", bus, logStream };
  const app = buildApp(deps);
  closers.push(() => app.close());
  const create = async (description = "add hello.txt") => {
    const res = await app.inject({ method: "POST", url: "/tasks", headers: json, payload: { project_id: 1, description } });
    expect(res.statusCode).toBe(201);
    return res.json().id as number;
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  return { repo, db, bus, tasks, approvals, pushed, agents, pipeline, app, deps, logs, create, sleep, git };
}

const headSha = (repo: string) => simpleGit(repo).revparse(["main"]);

describe("M7 acceptance", () => {
  it("1. a task opened in the app shows up in the core and the task list within one second", async () => {
    const t = await boot();
    const [server] = await startServers(t.deps, ["127.0.0.1"], 0);
    closers.push(() => server!.close());
    const port = (server!.server.address() as { port: number }).port;
    const stream = await fetch(`http://127.0.0.1:${port}/events`, { headers: auth });
    const reader = stream.body!.getReader();
    await reader.read(); // ": connected"

    const started = Date.now();
    const res = await fetch(`http://127.0.0.1:${port}/tasks`, { method: "POST", headers: json, body: JSON.stringify({ project_id: 1, description: "from the phone" }) });
    const { id } = (await res.json()) as { id: number };
    const event = new TextDecoder().decode((await reader.read()).value);
    const listed = (await (await fetch(`http://127.0.0.1:${port}/tasks`, { headers: auth })).json()) as { id: number }[];
    expect(Date.now() - started).toBeLessThan(1000);
    expect(event).toContain("event: task");
    expect(listed.map((x) => x.id)).toContain(id);
    expect(t.tasks.get(id).description).toBe("from the phone");
    await reader.cancel();
    await t.pipeline.idle();
  });

  it("2. a request without the access token is rejected and logged, without its content", async () => {
    const t = await boot();
    const none = await t.app.inject({ method: "POST", url: "/chat", payload: { text: "SECRET-BODY-TEXT" } });
    const wrong = await t.app.inject({ method: "GET", url: "/tasks?q=SECRET-QUERY", headers: { authorization: "Bearer WRONG-TOKEN-VALUE" } });
    expect([none.statusCode, wrong.statusCode]).toEqual([401, 401]);
    const log = t.logs.join("");
    expect(log).toContain("rejected unauthenticated request");
    expect(log).toContain('"path":"/chat"');
    for (const leaked of ["SECRET-BODY-TEXT", "SECRET-QUERY", "WRONG-TOKEN-VALUE", TOKEN]) expect(log).not.toContain(leaked);
  });

  it("3. the planner returns a plan that passes the handoff contract", async () => {
    const t = await boot();
    const id = await t.create();
    await t.pipeline.idle();
    const row = t.db.prepare("SELECT handoff FROM steps WHERE task_id = ? AND agent = 'planner'").get(id) as { handoff: string };
    const plan = handoffSchema.parse(JSON.parse(row.handoff));
    expect(plan).toMatchObject({ agent: "planner", task_id: String(id), status: "done" });
    expect(plan.open_items.length).toBeGreaterThan(0);
  });

  it("4. the builder works on a separate branch and never touches main", async () => {
    const t = await boot();
    const before = await headSha(t.repo);
    const id = await t.create();
    await t.pipeline.idle();
    expect(await headSha(t.repo)).toBe(before);
    expect(existsSync(join(t.repo, "hello.txt"))).toBe(false);
    expect((await simpleGit(t.repo).branchLocal()).all).toContain(`task-${id}`);
    expect(await simpleGit(t.repo).raw(["show", `task-${id}:hello.txt`])).toBe("hi\n");
    expect((await simpleGit(t.repo).raw(["log", "main", "--oneline"])).trim().split("\n")).toHaveLength(1);
  });

  it("5. the approval alert reaches the phone, reminders follow at 10 and 20 minutes, and the approve button merges", async () => {
    const t = await boot();
    const id = await t.create();
    await t.pipeline.idle();
    await t.sleep(20);
    expect(t.pushed.map((p) => p.title)).toEqual(["בקשת אישור חדשה"]);

    const approval = t.approvals.pending()[0]!;
    const at = (min: number) => new Date(Date.parse(approval.created_at) + min * 60_000);
    const remind = (min: number) =>
      t.approvals.sendDueReminders((a, n) => t.bus.publish({ type: "reminder", data: { approval_id: a.id, task_id: a.task_id, number: n } }), at(min));
    expect(await remind(9)).toBe(0);
    expect(await remind(10)).toBe(1);
    expect(await remind(20)).toBe(1);
    expect(await remind(45)).toBe(0); // only two reminders, then the task just keeps waiting
    await t.sleep(20);
    expect(t.pushed.map((p) => p.title)).toEqual(["בקשת אישור חדשה", "תזכורת לאישור", "תזכורת לאישור"]);
    expect(t.tasks.get(id).status).toBe("awaiting_approval");

    const res = await t.app.inject({ method: "POST", url: `/approvals/${approval.id}`, headers: json, payload: { decision: "approve" } });
    expect(res.statusCode).toBe(200);
    expect(t.tasks.get(id).status).toBe("merged");
    expect(readFileSync(join(t.repo, "hello.txt"), "utf8")).toBe("hi\n");
  });

  it("6. two builder failures escalate to Opus and the escalation is logged", async () => {
    const t = await boot({
      behaviour: { builder: (call, n) => (n <= 2 ? { handoff: { not: "a handoff" } } : { handoff: handoff(1, "builder") }) },
    });
    const id = await t.create();
    await t.pipeline.idle();
    expect(t.db.prepare("SELECT agent, model, valid_output, escalated FROM llm_calls ORDER BY id").all()).toEqual([
      { agent: "planner", model: "sonnet", valid_output: 1, escalated: 0 },
      { agent: "builder", model: "sonnet", valid_output: 0, escalated: 0 },
      { agent: "builder", model: "sonnet", valid_output: 0, escalated: 0 },
      { agent: "builder", model: "opus", valid_output: 1, escalated: 1 },
    ]);
    const log = t.db.prepare("SELECT summary FROM steps WHERE task_id = ? AND status = 'escalation'").all(id) as { summary: string }[];
    expect(log).toHaveLength(1);
    expect(log[0]!.summary).toMatch(/opus.*2 consecutive failures/);
  });

  it("7. going over the token budget stops the task", async () => {
    const t = await boot({ cap: 1000, behaviour: { planner: () => ({ handoff: handoff(1, "planner"), tokens: { in: 1500, out: 100 } }) } });
    const id = await t.create();
    await t.pipeline.idle();
    expect(t.tasks.get(id)).toMatchObject({ status: "stopped", tokens_used: 1600 });
    expect(t.agents.calls.map((c) => c.role)).toEqual(["planner"]); // the builder never started
    expect(t.db.prepare("SELECT summary FROM steps WHERE task_id = ? AND to_status = 'stopped'").get(id)).toMatchObject({ summary: expect.stringContaining("token cap") });
  });

  it("8. the stop button halts an active task immediately", async () => {
    let signal: AbortSignal | undefined;
    let release!: () => void;
    const t = await boot({
      behaviour: {
        builder: async ({ options }) => {
          signal = options.abortController?.signal;
          await new Promise<void>((r) => (release = r));
          return { handoff: handoff(1, "builder") };
        },
      },
    });
    const id = await t.create();
    for (let i = 0; i < 50 && !signal; i++) await t.sleep(20); // wait until the builder is running

    const started = Date.now();
    const res = await t.app.inject({ method: "POST", url: `/tasks/${id}/stop`, headers: json, payload: {} });
    expect(res.json()).toMatchObject({ status: "stopped" });
    expect(signal?.aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(500);
    release();
    await t.pipeline.idle();
    expect(t.tasks.get(id).status).toBe("stopped");
    expect(t.approvals.pending()).toHaveLength(0);
  });

  it("9. the usage screen matches the llm_calls log", async () => {
    const t = await boot({
      behaviour: {
        planner: (_c) => ({ handoff: handoff(1, "planner"), tokens: { in: 120, out: 12 } }),
        builder: async ({ options }, _n) => {
          const { writeFileSync } = await import("node:fs");
          writeFileSync(join(String(options.cwd), "a.txt"), "a");
          return { handoff: handoff(1, "builder"), tokens: { in: 300, out: 30 } };
        },
      },
    });
    await t.create();
    await t.pipeline.idle();
    const usage = (await t.app.inject({ url: "/usage", headers: auth })).json();
    const fromLog = t.db.prepare("SELECT COUNT(*) AS calls, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens FROM llm_calls").get();
    expect(usage).toMatchObject(fromLog as object);
    expect(usage).toMatchObject({ calls: 2, input_tokens: 420, output_tokens: 42 });
  });
});
