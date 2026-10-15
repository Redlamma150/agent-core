import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/api/server.js";
import { AgentRunner, type QueryFn } from "../src/agents/runner.js";
import { ActivityService } from "../src/core/activity.js";
import { ApprovalService } from "../src/core/approvals.js";
import { BudgetService } from "../src/core/budget.js";
import { Pipeline } from "../src/core/pipeline.js";
import { InvalidActionError, TaskService } from "../src/core/tasks.js";
import { openDb } from "../src/db/index.js";
import { fakeAgents, handoff } from "./fake-agents.js";
import { makeRepo } from "./repo-helper.js";

const TOKEN = "t".repeat(40);
const auth = { authorization: `Bearer ${TOKEN}` };

async function setup(opts: { cap?: number; testCommand?: string; agents?: ReturnType<typeof fakeAgents> } = {}) {
  const { repo, git } = await makeRepo();
  const db = openDb(":memory:");
  db.prepare("INSERT INTO projects (name, repo_path, test_command) VALUES ('proj', ?, ?)").run(repo, opts.testCommand ?? null);
  const tasks = new TaskService(db);
  const activity = new ActivityService(db);
  const approvals = new ApprovalService(db, tasks, { reminderMinutes: 10, reminderCount: 2 });
  const agents = opts.agents ?? fakeAgents();
  const budget = new BudgetService(tasks, opts.cap ?? 1_000_000);
  const pipeline = new Pipeline({ db, tasks, approvals, runner: new AgentRunner(db, tasks, agents.query, activity), budget, git, activity }, () => {});
  return { repo, db, tasks, activity, approvals, pipeline, agents, budget };
}

const finish = async (t: Awaited<ReturnType<typeof setup>>) => t.pipeline.idle();

describe("live activity", () => {
  it("records tool names and short targets, never command arguments or contents", async () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO projects (name, repo_path) VALUES ('p', '/r')").run();
    const tasks = new TaskService(db);
    const activity = new ActivityService(db);
    const cwd = tmpdir();
    const query: QueryFn = async function* () {
      const tool = (name: string, input: Record<string, unknown>) =>
        ({ type: "assistant", message: { content: [{ type: "tool_use", name, input }, { type: "text", text: "secret thinking" }] } }) as unknown as SDKMessage;
      yield tool("Read", { file_path: join(cwd, "src", "a.ts") });
      yield tool("Bash", { command: "API_KEY=hunter2 npm test" });
      yield tool("Bash", { command: "npm run build --token=hunter2" });
      yield tool("Write", { file_path: join(cwd, "b.txt"), content: "TOP SECRET CONTENT" });
      yield { type: "result", subtype: "success", is_error: false, result: "", structured_output: handoff(1, "builder"), modelUsage: {} } as unknown as SDKMessage;
    };
    const task = tasks.create(1, "x");
    await new AgentRunner(db, tasks, query, activity).run({ taskId: task.id, role: "builder", model: "sonnet", prompt: "p", systemPrompt: "s", cwd });
    const rows = activity.list(task.id);
    expect(rows.map((r) => [r.tool, r.target])).toEqual([["Read", join("src", "a.ts")], ["Bash", null], ["Bash", "npm"], ["Write", "b.txt"]]);
    expect(JSON.stringify(rows)).not.toMatch(/hunter2|SECRET|thinking/);
  });

  it("the API returns activity after a given id and publishes it on the event bus", async () => {
    const t = await setup();
    const events: unknown[] = [];
    const bus = (await import("../src/api/events.js")).EventBus;
    const live = new bus();
    live.subscribe((e) => events.push(e));
    const activity = new ActivityService(t.db, live);
    const task = t.tasks.create(1, "x");
    activity.record(task.id, "builder", "Read", "a.ts");
    activity.record(task.id, "builder", "Edit", "b.ts");
    expect(events).toHaveLength(2);
    expect(activity.list(task.id, 1).map((r) => r.tool)).toEqual(["Edit"]);
  });
});

describe("edit, trash, archive", () => {
  it("edits only tasks that are not running and keeps the title in step with the text", async () => {
    const t = await setup();
    const task = t.tasks.create(1, "old title\nmore");
    expect(task.title).toBe("old title");
    expect(t.tasks.update(task.id, { description: "new title\nmore" }).title).toBe("new title");
    expect(t.tasks.update(task.id, { title: "custom" }).title).toBe("custom");
    t.tasks.transition(task.id, "planning");
    expect(() => t.tasks.update(task.id, { title: "x" })).toThrow(InvalidActionError);
  });

  it("trash refuses running tasks, restore brings the task back, and purge removes it after 30 days but keeps usage", async () => {
    const t = await setup();
    const task = t.tasks.create(1, "x");
    t.tasks.transition(task.id, "planning");
    expect(() => t.tasks.trash(task.id)).toThrow(InvalidActionError);
    t.tasks.stop(task.id);
    expect(t.tasks.trash(task.id).deleted_at).not.toBeNull();
    expect(t.tasks.restore(task.id).deleted_at).toBeNull();

    t.tasks.trash(task.id);
    t.db.prepare("INSERT INTO llm_calls (task_id, agent, model, input_tokens, output_tokens) VALUES (?, 'builder', 'm', 5, 5)").run(task.id);
    expect(t.tasks.purgeTrashed()).toBe(0);
    t.db.prepare("UPDATE tasks SET deleted_at = datetime('now', '-31 days') WHERE id = ?").run(task.id);
    expect(t.tasks.purgeTrashed()).toBe(1);
    expect(t.db.prepare("SELECT COUNT(*) AS n FROM tasks").get()).toEqual({ n: 0 });
    expect(t.db.prepare("SELECT COUNT(*) AS n, MIN(task_id) AS task FROM llm_calls").get()).toEqual({ n: 1, task: null });
  });

  it("archives only finished or stopped tasks", async () => {
    const t = await setup();
    const task = t.tasks.create(1, "x");
    expect(() => t.tasks.archive(task.id)).toThrow(InvalidActionError);
    t.tasks.stop(task.id);
    expect(t.tasks.archive(task.id).archived_at).not.toBeNull();
    expect(t.tasks.archive(task.id, false).archived_at).toBeNull();
  });
});

describe("continue and duplicate", () => {
  it("continues a blocked task with the owner's note and finishes it", async () => {
    const t = await setup();
    const task = t.tasks.create(1, "add hello.txt");
    t.tasks.transition(task.id, "blocked", "waiting for the owner");
    t.pipeline.continueTask(task.id, "use the file name hello.txt");
    await finish(t);
    expect(t.tasks.get(task.id).status).toBe("awaiting_approval");
    expect(t.agents.calls[0]?.prompt).toContain("use the file name hello.txt");
    expect(t.db.prepare("SELECT summary FROM steps WHERE task_id = ? AND status = 'owner_note'").get(task.id)).toEqual({ summary: "use the file name hello.txt" });
  });

  it("continues an owner-stopped task, resetting failure counters", async () => {
    const t = await setup();
    const task = t.tasks.create(1, "add hello.txt");
    t.tasks.recordFailure(task.id);
    t.tasks.stop(task.id);
    t.pipeline.continueTask(task.id);
    await finish(t);
    expect(t.tasks.get(task.id)).toMatchObject({ status: "awaiting_approval", failures: 0 });
  });

  it("a task stopped by the token cap gets one more full cap when continued", async () => {
    const t = await setup({ cap: 1000 });
    const task = t.tasks.create(1, "add hello.txt");
    t.tasks.addTokens(task.id, 1500);
    t.budget.enforce(task.id);
    expect(t.tasks.get(task.id).status).toBe("stopped");
    t.pipeline.continueTask(task.id);
    await finish(t);
    expect(t.tasks.get(task.id)).toMatchObject({ token_extra: 1000 });
    expect(t.tasks.get(task.id).status).not.toBe("stopped");
  });

  it("refuses to continue a running, merged or trashed task", async () => {
    const t = await setup();
    const running = t.tasks.create(1, "x");
    t.tasks.transition(running.id, "planning");
    expect(() => t.pipeline.continueTask(running.id)).toThrow(InvalidActionError);
    const trashed = t.tasks.create(1, "y");
    t.tasks.stop(trashed.id);
    t.tasks.trash(trashed.id);
    expect(() => t.pipeline.continueTask(trashed.id)).toThrow(/trash/);
  });

  it("duplicate starts a fresh task with the same text", async () => {
    const t = await setup();
    const task = t.tasks.create(1, "add hello.txt");
    t.tasks.stop(task.id);
    const copy = t.pipeline.duplicate(task.id);
    await finish(t);
    expect(copy.id).not.toBe(task.id);
    expect(t.tasks.get(copy.id)).toMatchObject({ description: "add hello.txt", status: "awaiting_approval" });
  });
});

describe("project tests before approval", () => {
  it("shows a passing result in the approval", async () => {
    const t = await setup({ testCommand: "node -e 0" });
    const task = t.tasks.create(1, "add hello.txt");
    t.pipeline.start(task.id);
    await finish(t);
    expect(t.approvals.pending()[0]?.request_text).toContain("הבדיקות של הפרויקט עברו");
  });

  it("a failing result does not block the task but is shown with the output", async () => {
    const t = await setup({ testCommand: "node -e console.error('boom');process.exit(3)" });
    const task = t.tasks.create(1, "add hello.txt");
    t.pipeline.start(task.id);
    await finish(t);
    expect(t.tasks.get(task.id).status).toBe("awaiting_approval");
    const text = t.approvals.pending()[0]?.request_text ?? "";
    expect(text).toContain("נכשלו (קוד 3)");
    expect(text).toContain("boom");
  });

  it("the tests do not see the core's secrets", async () => {
    process.env.APP_ACCESS_TOKEN = "s".repeat(40);
    try {
      const t = await setup({ testCommand: "node -e process.exit(process.env.APP_ACCESS_TOKEN?1:0)" });
      const task = t.tasks.create(1, "add hello.txt");
      t.pipeline.start(task.id);
      await finish(t);
      expect(t.approvals.pending()[0]?.request_text).toContain("עברו");
    } finally {
      delete process.env.APP_ACCESS_TOKEN;
    }
  });

  it("no test command means no test line", async () => {
    const t = await setup();
    t.pipeline.start(t.tasks.create(1, "add hello.txt").id);
    await finish(t);
    expect(t.approvals.pending()[0]?.request_text).not.toContain("הבדיקות");
  });
});

describe("task API", () => {
  async function api() {
    const t = await setup();
    const app = buildApp({ db: t.db, accessToken: TOKEN, tasks: t.tasks, approvals: t.approvals, driver: t.pipeline, activity: t.activity, push: { vapidPublicKey: "k" } as never, vapidPublicKey: "k" });
    return { t, app };
  }

  it("lists tasks by view and includes project name, title and the reason a task stopped", async () => {
    const { t, app } = await api();
    const a = t.tasks.create(1, "alpha");
    const b = t.tasks.create(1, "beta");
    t.tasks.transition(b.id, "blocked", "need a decision");
    t.tasks.stop(a.id);
    t.tasks.trash(a.id);
    const list = (view: string) => app.inject({ url: `/tasks?view=${view}`, headers: auth }).then((r) => r.json() as { id: number; reason: string | null; project_name: string; title: string }[]);
    expect((await list("active")).map((x) => x.id)).toEqual([b.id]);
    expect((await list("trash")).map((x) => x.id)).toEqual([a.id]);
    expect((await list("active"))[0]).toMatchObject({ project_name: "proj", title: "beta", reason: "need a decision" });
    expect((await app.inject({ url: "/tasks?view=nope", headers: auth })).statusCode).toBe(400);
  });

  it("edit, delete, restore and archive over HTTP, with 409 for actions that do not fit the state", async () => {
    const { t, app } = await api();
    const task = t.tasks.create(1, "alpha");
    const patch = await app.inject({ method: "PATCH", url: `/tasks/${task.id}`, headers: auth, payload: { description: "alpha two" } });
    expect(patch.json()).toMatchObject({ description: "alpha two", title: "alpha two" });
    expect((await app.inject({ method: "PATCH", url: `/tasks/${task.id}`, headers: auth, payload: {} })).statusCode).toBe(400);

    t.tasks.transition(task.id, "planning");
    expect((await app.inject({ method: "DELETE", url: `/tasks/${task.id}`, headers: auth })).statusCode).toBe(409);
    expect((await app.inject({ method: "PATCH", url: `/tasks/${task.id}`, headers: auth, payload: { title: "x" } })).statusCode).toBe(409);

    t.tasks.stop(task.id);
    expect((await app.inject({ method: "POST", url: `/tasks/${task.id}/archive`, headers: auth })).json()).toMatchObject({ archived_at: expect.any(String) });
    expect((await app.inject({ method: "DELETE", url: `/tasks/${task.id}`, headers: auth })).json()).toMatchObject({ deleted_at: expect.any(String) });
    expect((await app.inject({ method: "POST", url: `/tasks/${task.id}/restore`, headers: auth })).json()).toMatchObject({ deleted_at: null });
    expect((await app.inject({ method: "DELETE", url: "/tasks/999", headers: auth })).statusCode).toBe(404);
  });

  it("continue and duplicate over HTTP, plus steps, activity and the project list", async () => {
    const { t, app } = await api();
    const task = t.tasks.create(1, "add hello.txt");
    t.tasks.transition(task.id, "blocked", "stuck");
    const res = await app.inject({ method: "POST", url: `/tasks/${task.id}/continue`, headers: auth, payload: { note: "go on" } });
    expect(res.statusCode).toBe(200);
    await t.pipeline.idle();
    expect(t.tasks.get(task.id).status).toBe("awaiting_approval");

    expect((await app.inject({ method: "POST", url: `/tasks/${task.id}/continue`, headers: auth, payload: {} })).statusCode).toBe(409);
    const copy = await app.inject({ method: "POST", url: `/tasks/${task.id}/duplicate`, headers: auth });
    expect(copy.statusCode).toBe(201);
    await t.pipeline.idle();

    const steps = (await app.inject({ url: `/tasks/${task.id}/steps`, headers: auth })).json() as { to_status: string | null }[];
    expect(steps.map((s) => s.to_status).filter(Boolean)).toContain("blocked");
    t.activity.record(task.id, "builder", "Read", "a.ts");
    expect((await app.inject({ url: `/tasks/${task.id}/activity`, headers: auth })).json()).toMatchObject([{ tool: "Read", target: "a.ts" }]);
    expect((await app.inject({ url: "/projects", headers: auth })).json()).toEqual([{ id: 1, name: "proj" }]);
    expect((await app.inject({ url: "/projects", headers: {} })).statusCode).toBe(401);
  });

  it("usage reports recent windows and the heaviest tasks", async () => {
    const { t, app } = await api();
    const task = t.tasks.create(1, "alpha");
    t.db.prepare("INSERT INTO llm_calls (task_id, agent, model, input_tokens, output_tokens) VALUES (?, 'builder', 'm', 700, 300)").run(task.id);
    t.db.prepare("INSERT INTO llm_calls (task_id, agent, model, input_tokens, output_tokens, created_at) VALUES (?, 'builder', 'm', 50, 50, datetime('now','-2 days'))").run(task.id);
    const usage = (await app.inject({ url: "/usage", headers: auth })).json();
    expect(usage).toMatchObject({ calls: 2, last_5h: { calls: 1, input_tokens: 700, output_tokens: 300 }, last_7d: { calls: 2 }, top_tasks: [{ id: task.id, tokens: 1100 }] });
  });
});
