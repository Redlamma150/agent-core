import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { executeAgent } from "../src/agents/execute.js";
import { AgentRunner, type QueryFn } from "../src/agents/runner.js";
import { buildApp } from "../src/api/server.js";
import { ApprovalService } from "../src/core/approvals.js";
import { BudgetService } from "../src/core/budget.js";
import { Pipeline } from "../src/core/pipeline.js";
import { QuotaService, RESUME_MARGIN_MS } from "../src/core/quota.js";
import { Scheduler } from "../src/core/scheduler.js";
import { SettingsService } from "../src/core/settings.js";
import { TaskService } from "../src/core/tasks.js";
import { openDb } from "../src/db/index.js";
import { services } from "./api.test.js";
import { makeRepo } from "./repo-helper.js";

/** A report exactly as the Claude Code runtime sent it (captured from a real call). */
const REAL_EVENT = {
  status: "allowed",
  resetsAt: 1792185600,
  rateLimitType: "five_hour",
  overageStatus: "rejected",
  overageDisabledReason: "out_of_credits",
  isUsingOverage: false,
  unifiedWindows: { five_hour: { utilization: 0.76, resetsAt: 1792185600 }, seven_day: { utilization: 0.43, resetsAt: 1792634400 } },
};
const at = (epochSeconds: number) => new Date(epochSeconds * 1000);

function quotaSetup() {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO projects (name, repo_path) VALUES ('p', '/r')").run();
  const settings = new SettingsService(db);
  return { db, settings, quota: new QuotaService(db, settings) };
}

describe("QuotaService", () => {
  it("learns both usage windows from a real report, as percent with their reset times", () => {
    const { quota } = quotaSetup();
    expect(quota.record(REAL_EVENT)).toBeNull(); // allowed: nothing is blocked
    const snap = quota.snapshot(at(1792180800));
    expect(snap.five_hour).toEqual({ percent: 76, resets_at: "2026-10-16T21:20:00.000Z" });
    expect(snap.seven_day).toEqual({ percent: 43, resets_at: "2026-10-22T02:00:00.000Z" });
    expect(snap.blocked_until).toBeNull();
    expect(quota.nextReset(at(1792180800))).toEqual(at(1792185600));
  });

  it("forgets a window once it has reset, because the new one is unknown", () => {
    const { quota } = quotaSetup();
    quota.record(REAL_EVENT);
    const later = quota.snapshot(at(1792185601));
    expect(later.five_hour).toBeNull();
    expect(later.seven_day).not.toBeNull(); // the weekly window is still running
    expect(quota.nextReset(at(1792185601))).toBeNull();
  });

  it("reads a single window report when the runtime sends only that", () => {
    const { quota } = quotaSetup();
    quota.record({ status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.9, resetsAt: 1792634400 });
    expect(quota.snapshot(at(1792180800)).seven_day).toMatchObject({ percent: 90 });
  });

  it("a refusal blocks work until the window resets, and the block expires by itself", () => {
    const { quota } = quotaSetup();
    const until = quota.record({ ...REAL_EVENT, status: "rejected" }, at(1792180800));
    expect(until).toEqual(at(1792185600));
    expect(quota.blockedUntil(at(1792181000))).toEqual(at(1792185600));
    expect(quota.blockedUntil(at(1792185601))).toBeNull();
    quota.block(at(1792190000));
    quota.clearBlock();
    expect(quota.blockedUntil(at(1792181000))).toBeNull();
  });

  it("falls back to a short wait when a refusal does not say when the window resets", () => {
    const { quota } = quotaSetup();
    const now = at(1792180800);
    expect(quota.record({ status: "rejected" }, now)!.getTime()).toBe(now.getTime() + 15 * 60_000);
  });

  it("auto resume is on unless switched off", () => {
    const { quota } = quotaSetup();
    expect(quota.autoResume()).toBe(true);
    quota.setAutoResume(false);
    expect(quota.autoResume()).toBe(false);
    quota.setAutoResume(true);
    expect(quota.autoResume()).toBe(true);
  });
});

const rateEvent = (info: object) => ({ type: "rate_limit_event", rate_limit_info: info }) as unknown as SDKMessage;
const failure = { type: "result", subtype: "success", is_error: true, result: "You've hit your limit", modelUsage: {} } as unknown as SDKMessage;
const done = (structured: unknown): SDKMessage =>
  ({ type: "result", subtype: "success", is_error: false, result: "", structured_output: structured, modelUsage: { m: { inputTokens: 10, outputTokens: 5, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 } } }) as unknown as SDKMessage;
const handoff = (taskId: number, agent: string) => ({ task_id: String(taskId), agent, status: "done", summary: "סיכום", artifacts: [], open_items: ["שלב"], needs_approval: false, confidence: 0.9 });

describe("a refused call is a pause, not a failure", () => {
  it("the runner reports when the quota comes back and logs nothing as a bad answer", async () => {
    const { db, quota } = quotaSetup();
    const tasks = new TaskService(db);
    const task = tasks.create(1, "x");
    const query: QueryFn = async function* () {
      yield rateEvent({ ...REAL_EVENT, status: "rejected" });
      yield failure;
    };
    const runner = new AgentRunner(db, tasks, query, undefined, [], quota);
    const res = await runner.run({ taskId: task.id, role: "planner", model: "sonnet", prompt: "p", systemPrompt: "s", cwd: process.cwd() });
    expect(res).toMatchObject({ ok: false, quotaUntil: at(1792185600) });
    expect(db.prepare("SELECT COUNT(*) AS n FROM llm_calls").get()).toEqual({ n: 0 });
    expect(quota.snapshot(at(1792180800)).five_hour?.percent).toBe(76); // the report was kept
  });

  it("an assistant message with a rate_limit error also counts, waiting for the known window", async () => {
    const { db, quota } = quotaSetup();
    quota.record(REAL_EVENT);
    const tasks = new TaskService(db);
    const task = tasks.create(1, "x");
    const query: QueryFn = async function* () {
      yield { type: "assistant", error: "rate_limit", message: { content: [] } } as unknown as SDKMessage;
      yield failure;
    };
    const res = await new AgentRunner(db, tasks, query, undefined, [], quota).run({ taskId: task.id, role: "planner", model: "sonnet", prompt: "p", systemPrompt: "s", cwd: process.cwd() });
    expect(res.ok).toBe(false);
    expect((res as { quotaUntil?: Date }).quotaUntil).toBeInstanceOf(Date);
    expect(quota.blockedUntil()).not.toBeNull();
  });

  it("executeAgent pauses without counting a failure or escalating", async () => {
    const { db, quota } = quotaSetup();
    const tasks = new TaskService(db);
    const task = tasks.create(1, "x");
    const query: QueryFn = async function* () {
      yield rateEvent({ ...REAL_EVENT, status: "rejected" });
      yield failure;
    };
    const runner = new AgentRunner(db, tasks, query, undefined, [], quota);
    const out = await executeAgent({ tasks, runner, budget: new BudgetService(tasks, 1_000_000) }, { taskId: task.id, role: "planner", systemPrompt: "s", prompt: "p", cwd: process.cwd() });
    expect(out).toEqual({ kind: "paused", until: at(1792185600) });
    expect(tasks.get(task.id)).toMatchObject({ failures: 0, escalations: 0 });
  });
});

describe("pipeline under a quota refusal", () => {
  // The reset is always two hours from now, so the test does not depend on today's date.
  const RESET = Math.floor(Date.now() / 1000) + 7200;
  const refusal = () => rateEvent({ ...REAL_EVENT, status: "rejected", resetsAt: RESET, unifiedWindows: { five_hour: { utilization: 1, resetsAt: RESET } } });

  async function setup(autoResume = true) {
    const { repo, git } = await makeRepo();
    const db = openDb(":memory:");
    db.prepare("INSERT INTO projects (name, repo_path) VALUES ('proj', ?)").run(repo);
    const settings = new SettingsService(db);
    const quota = new QuotaService(db, settings);
    quota.setAutoResume(autoResume);
    const tasks = new TaskService(db);
    const approvals = new ApprovalService(db, tasks, { reminderMinutes: 10, reminderCount: 2 });
    const state = { refuse: true, calls: 0 };
    const query: QueryFn = async function* ({ prompt, options }: { prompt: string; options: Options }) {
      state.calls++;
      const taskId = Number(/Task (\d+)/.exec(prompt)?.[1]);
      if (state.refuse) {
        yield refusal();
        yield failure;
        return;
      }
      const planner = String(options.systemPrompt).includes("planner agent");
      if (!planner) writeFileSync(join(String(options.cwd), "hello.txt"), "hi\n");
      yield done(handoff(taskId, planner ? "planner" : "builder"));
    };
    const runner = new AgentRunner(db, tasks, query, undefined, [], quota);
    const pipeline = new Pipeline({ db, tasks, approvals, runner, budget: new BudgetService(tasks, 1_000_000), git, quota }, () => {});
    return { repo, db, tasks, approvals, pipeline, quota, state, scheduler: new Scheduler(db, tasks, pipeline) };
  }

  it("parks the task where it is, keeps the others from spending calls, and resumes everything when the quota is back", async () => {
    const t = await setup();
    const first = t.tasks.create(1, "first");
    const second = t.tasks.create(1, "second");
    t.pipeline.start(first.id);
    t.pipeline.start(second.id);
    await t.pipeline.idle();

    expect(t.state.calls).toBe(1); // only the first task reached the subscription; the second waited without a call
    for (const id of [first.id, second.id]) {
      const task = t.tasks.get(id);
      expect(task.pause_reason).toBe("quota");
      expect(task.scheduled_for).toBe(new Date((RESET + 60) * 1000).toISOString().slice(0, 19).replace("T", " ")); // reset + one minute
      expect(["received", "planning"]).toContain(task.status);
    }
    expect(t.tasks.get(first.id)).toMatchObject({ failures: 0 });
    expect(t.db.prepare("SELECT summary FROM steps WHERE task_id = ? AND status = 'quota_paused'").get(first.id)).toMatchObject({ summary: expect.stringContaining("מושהית") });
    expect(t.tasks.resumable()).toEqual([]); // a restart does not wake them early

    t.state.refuse = false;
    t.quota.clearBlock();
    expect(t.scheduler.runDue(new Date(RESET * 1000))).toBe(0); // not yet
    expect(t.scheduler.runDue(new Date((RESET + 120) * 1000))).toBe(2);
    await t.pipeline.idle();
    expect(t.tasks.get(first.id).status).toBe("awaiting_approval");
    expect(t.tasks.get(second.id).status).toBe("awaiting_approval");
    expect(t.tasks.get(first.id)).toMatchObject({ scheduled_for: null, pause_reason: null });
  });

  it("with auto resume off the task is blocked with the time the quota is back, and can be continued", async () => {
    const t = await setup(false);
    const task = t.tasks.create(1, "x");
    t.pipeline.start(task.id);
    await t.pipeline.idle();
    expect(t.tasks.get(task.id).status).toBe("blocked");
    expect(t.db.prepare("SELECT summary FROM steps WHERE task_id = ? AND to_status = 'blocked'").get(task.id)).toMatchObject({ summary: expect.stringContaining("quota used up") });

    t.state.refuse = false;
    t.pipeline.continueTask(task.id); // clears the block: the owner chose to try
    await t.pipeline.idle();
    expect(t.tasks.get(task.id).status).toBe("awaiting_approval");
  });

  it("a paused task that is stopped never wakes up again", async () => {
    const t = await setup();
    const task = t.tasks.create(1, "x");
    t.pipeline.start(task.id);
    await t.pipeline.idle();
    t.tasks.stop(task.id);
    expect(t.tasks.get(task.id)).toMatchObject({ scheduled_for: null, pause_reason: null });
    t.state.refuse = false;
    expect(t.scheduler.runDue(new Date((RESET + 3600) * 1000))).toBe(0);
    expect(existsSync(join(t.repo, "hello.txt"))).toBe(false);
  });
});

describe("API", () => {
  const TOKEN = "t".repeat(40);
  const auth = { authorization: `Bearer ${TOKEN}` };
  function appWith(withReset: boolean) {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO projects (name, repo_path) VALUES ('p', '/r')").run();
    const settings = new SettingsService(db);
    const quota = new QuotaService(db, settings);
    if (withReset) quota.record({ ...REAL_EVENT, resetsAt: Math.floor(Date.now() / 1000) + 7200, unifiedWindows: { five_hour: { utilization: 0.5, resetsAt: Math.floor(Date.now() / 1000) + 7200 } } });
    const base = services(db);
    const app = buildApp({ db, accessToken: TOKEN, ...base, settings, quota });
    return { app, base, quota, send: (method: "GET" | "POST" | "PUT", url: string, payload?: object) => app.inject({ method, url, headers: auth, payload }) };
  }

  it("shows the real usage windows in /usage", async () => {
    const t = appWith(true);
    const usage = (await t.send("GET", "/usage")).json();
    expect(usage.quota.five_hour.percent).toBe(50);
    expect(usage.quota.blocked_until).toBeNull();
    expect((await appWith(false).send("GET", "/usage")).json().quota.five_hour).toBeNull();
  });

  it("'when the quota comes back' waits for the next reset, or starts now when none is known", async () => {
    const t = appWith(true);
    const waiting = (await t.send("POST", "/tasks", { project_id: 1, description: "later", when: "quota" })).json();
    expect(waiting.pause_reason).toBe("quota");
    expect(new Date(waiting.scheduled_for.replace(" ", "T") + "Z").getTime()).toBeGreaterThan(Date.now() + 7200_000);
    expect(t.base.started).toEqual([]);

    const t2 = appWith(false);
    const now = (await t2.send("POST", "/tasks", { project_id: 1, description: "now", when: "quota" })).json();
    expect(now.scheduled_for).toBeNull();
    expect(t2.base.started).toEqual([now.id]);
  });

  it("starting a paused task by hand clears the wait and the block", async () => {
    const t = appWith(true);
    const waiting = (await t.send("POST", "/tasks", { project_id: 1, description: "later", when: "quota" })).json();
    t.quota.block(new Date(Date.now() + 3600_000));
    const started = await t.send("POST", `/tasks/${waiting.id}/start`, {});
    expect(started.json()).toMatchObject({ scheduled_for: null, pause_reason: null });
    expect(t.quota.blockedUntil()).toBeNull();
    expect(t.base.started).toEqual([waiting.id]);
  });

  it("keeps the auto resume switch", async () => {
    const t = appWith(false);
    expect((await t.send("GET", "/settings")).json().auto_resume).toBe(true);
    expect((await t.send("PUT", "/settings", { auto_resume: false })).json().auto_resume).toBe(false);
    expect((await t.send("GET", "/settings")).json().auto_resume).toBe(false);
  });
});

void RESUME_MARGIN_MS;
