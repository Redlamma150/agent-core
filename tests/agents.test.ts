import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { EventBus } from "../src/api/events.js";
import { parseHandoff, handoffJsonSchema } from "../src/agents/contract.js";
import { executeAgent } from "../src/agents/execute.js";
import { route, type RouteInput } from "../src/agents/router.js";
import { AgentRunner, type QueryFn } from "../src/agents/runner.js";
import { BudgetService } from "../src/core/budget.js";
import { TaskService } from "../src/core/tasks.js";
import { openDb } from "../src/db/index.js";

const base: RouteInput = { role: "builder", consecutiveFailures: 0, escalations: 0, flagged: false };

describe("router", () => {
  it("uses Sonnet by default for every role", () => {
    for (const role of ["planner", "builder", "tester", "red_team", "operator"] as const) {
      expect(route({ ...base, role })).toMatchObject({ action: "run", model: "sonnet", escalate: false });
    }
  });
  it("escalates to Opus after two consecutive failures, not after one", () => {
    expect(route({ ...base, consecutiveFailures: 1 })).toMatchObject({ model: "sonnet", escalate: false });
    expect(route({ ...base, consecutiveFailures: 2 })).toMatchObject({ model: "opus", escalate: true });
  });
  it("escalates a flagged task, and low confidence", () => {
    expect(route({ ...base, flagged: true })).toMatchObject({ model: "opus", escalate: true });
    expect(route({ ...base, lastConfidence: 0.59 })).toMatchObject({ model: "opus", escalate: true });
    expect(route({ ...base, lastConfidence: 0.6 })).toMatchObject({ model: "sonnet", escalate: false });
  });
  it("stays on Opus after an escalation and blocks once the two escalations are used", () => {
    expect(route({ ...base, escalations: 1, flagged: true })).toMatchObject({ model: "opus", escalate: false });
    expect(route({ ...base, escalations: 1, consecutiveFailures: 2 })).toMatchObject({ model: "opus", escalate: true });
    const blocked = route({ ...base, escalations: 2, consecutiveFailures: 2 });
    expect(blocked.action).toBe("block");
  });
});

describe("contract", () => {
  const valid = { task_id: "7", agent: "builder", status: "done", summary: "ok", artifacts: [], open_items: [], needs_approval: false, confidence: 0.9 };
  it("accepts a valid handoff and rejects every kind of bad one", () => {
    expect(parseHandoff(valid, { taskId: 7, role: "builder" }).ok).toBe(true);
    for (const bad of [{ ...valid, confidence: 1.5 }, { ...valid, status: "weird" }, { ...valid, artifacts: "x" }, { ...valid, task_id: undefined }, "text", null]) {
      expect(parseHandoff(bad, { taskId: 7, role: "builder" }).ok).toBe(false);
    }
    expect(parseHandoff(valid, { taskId: 8, role: "builder" })).toMatchObject({ ok: false, error: expect.stringContaining("task_id") });
    expect(parseHandoff(valid, { taskId: 7, role: "planner" })).toMatchObject({ ok: false, error: expect.stringContaining("agent") });
  });
  it("exposes a JSON schema for the SDK", () => {
    expect(handoffJsonSchema).toMatchObject({ type: "object", required: expect.arrayContaining(["task_id", "confidence"]) });
    expect(handoffJsonSchema).not.toHaveProperty("$schema");
  });
});

// ---- fake SDK ----------------------------------------------------------------------------------------------------
const good = (taskId: number, over: Record<string, unknown> = {}) => ({
  task_id: String(taskId), agent: "builder", status: "done", summary: "done", artifacts: [], open_items: [], needs_approval: false, confidence: 0.9, ...over,
});

function result(structured: unknown, tokens = 100, extra: Record<string, unknown> = {}): SDKMessage {
  return {
    type: "result", subtype: "success", is_error: false, result: "", structured_output: structured,
    modelUsage: { m: { inputTokens: tokens, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 } },
    ...extra,
  } as unknown as SDKMessage;
}

/** Scripted fake of query(): each call pops the next step and records the options it was given. */
function fakeQuery(steps: (() => SDKMessage | Error)[]) {
  const calls: Options[] = [];
  const fn: QueryFn = async function* ({ options }) {
    calls.push(options);
    const step = steps.shift();
    if (!step) throw new Error("unexpected extra call");
    const r = step();
    if (r instanceof Error) throw r;
    yield r;
  };
  return { fn, calls };
}

function setup(steps: (() => SDKMessage | Error)[], cap = 200000, flagged = false) {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO projects (name, repo_path) VALUES ('p','/r')").run();
  const bus = new EventBus();
  const events: { type: string; data: unknown }[] = [];
  bus.subscribe((e) => events.push(e));
  const tasks = new TaskService(db, bus);
  const task = tasks.create(1, "work", flagged);
  const q = fakeQuery(steps);
  const runner = new AgentRunner(db, tasks, q.fn);
  const budget = new BudgetService(tasks, cap, bus);
  const run = () => executeAgent({ tasks, runner, budget }, { taskId: task.id, role: "builder", prompt: "go", systemPrompt: "sys", cwd: "/r" });
  return { db, tasks, task, q, run, events };
}

const callsLog = (db: ReturnType<typeof openDb>) => db.prepare("SELECT model, valid_output, escalated, input_tokens FROM llm_calls ORDER BY id").all();

describe("runner", () => {
  it("validates output, logs the call and adds tokens to the task", async () => {
    const t = setup([() => result(good(1), 250)]);
    const out = await t.run();
    expect(out.kind).toBe("completed");
    expect(callsLog(t.db)).toEqual([{ model: "sonnet", valid_output: 1, escalated: 0, input_tokens: 250 }]);
    expect(t.tasks.get(t.task.id).tokens_used).toBe(250);
  });

  it("never passes an API key to the SDK, and asks for the contract schema", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-should-not-leak";
    try {
      const t = setup([() => result(good(1))]);
      await t.run();
      expect(t.q.calls[0]?.env?.ANTHROPIC_API_KEY).toBeUndefined();
      expect(t.q.calls[0]?.outputFormat).toMatchObject({ type: "json_schema" });
      expect(t.q.calls[0]?.model).toBe("sonnet");
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it("passes the role's tool list through and loads no settings by default", async () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO projects (name, repo_path) VALUES ('p','/r')").run();
    const tasks = new TaskService(db);
    const task = tasks.create(1, "x");
    const q = fakeQuery([() => result(good(task.id))]);
    await new AgentRunner(db, tasks, q.fn).run({ taskId: task.id, role: "builder", model: "sonnet", prompt: "p", systemPrompt: "s", cwd: "/r", tools: ["Read", "Grep"] });
    expect(q.calls[0]).toMatchObject({ tools: ["Read", "Grep"], settingSources: [] });
  });

  it("falls back to parsing the result text when there is no structured output", async () => {
    const t = setup([() => result(undefined, 10, { result: JSON.stringify(good(1)) })]);
    expect((await t.run()).kind).toBe("completed");
  });

  it("treats invalid output, SDK errors and exceptions as failures and logs them as invalid", async () => {
    const t = setup([
      () => result({ nonsense: true }),
      () => result(undefined, 0, { subtype: "error_max_turns" }),
      () => new Error("spawn failed"),
      () => result(good(1)),
    ]);
    // two failures escalate; third failure is on Opus; fourth succeeds
    await t.run();
    expect(callsLog(t.db).map((c: any) => c.valid_output)).toEqual([0, 0, 0, 1]);
  });
});

describe("escalation", () => {
  it("escalates to Opus after two consecutive failures and logs it", async () => {
    const t = setup([() => result({ bad: 1 }), () => result({ bad: 2 }), () => result(good(1))]);
    const out = await t.run();
    expect(out.kind).toBe("completed");
    expect(callsLog(t.db)).toEqual([
      { model: "sonnet", valid_output: 0, escalated: 0, input_tokens: 100 },
      { model: "sonnet", valid_output: 0, escalated: 0, input_tokens: 100 },
      { model: "opus", valid_output: 1, escalated: 1, input_tokens: 100 },
    ]);
    const log = t.db.prepare("SELECT status, summary FROM steps WHERE status = 'escalation'").all() as { summary: string }[];
    expect(log).toHaveLength(1);
    expect(log[0]?.summary).toContain("2 consecutive failures");
    expect(t.tasks.get(t.task.id)).toMatchObject({ escalations: 1, failures: 0 });
  });

  it("one failure does not escalate", async () => {
    const t = setup([() => result({ bad: 1 }), () => result(good(1))]);
    await t.run();
    expect((callsLog(t.db) as { model: string }[]).map((c) => c.model)).toEqual(["sonnet", "sonnet"]);
  });

  it("escalates a flagged task immediately", async () => {
    const t = setup([() => result(good(1))], 200000, true);
    await t.run();
    expect(callsLog(t.db)).toEqual([{ model: "opus", valid_output: 1, escalated: 1, input_tokens: 100 }]);
  });

  it("re-runs on Opus when confidence is below 0.6", async () => {
    const t = setup([() => result(good(1, { confidence: 0.4 })), () => result(good(1, { confidence: 0.8 }))]);
    const out = await t.run();
    expect(out).toMatchObject({ kind: "completed", handoff: { confidence: 0.8 } });
    expect((callsLog(t.db) as { model: string }[]).map((c) => c.model)).toEqual(["sonnet", "opus"]);
  });

  it("blocks the task after the second escalation also fails", async () => {
    // sonnet x2 fail -> escalate 1 -> opus x2 fail -> escalate 2 -> opus x2 fail -> would need a third escalation
    const fails = Array.from({ length: 6 }, () => () => result({ bad: true }));
    const t = setup(fails);
    const out = await t.run();
    expect(out.kind).toBe("blocked");
    expect(t.tasks.get(t.task.id)).toMatchObject({ status: "blocked", escalations: 2 });
    expect(t.db.prepare("SELECT COUNT(*) AS n FROM steps WHERE status = 'escalation'").get()).toEqual({ n: 2 });
  });

  it("an agent-reported failed status counts as a failure; blocked status blocks the task", async () => {
    const t = setup([() => result(good(1, { status: "failed" })), () => result(good(1, { status: "failed" })), () => result(good(1, { status: "blocked", summary: "need creds" }))]);
    const out = await t.run();
    expect(out).toMatchObject({ kind: "blocked", reasons: ["need creds"] });
    expect(t.tasks.get(t.task.id).status).toBe("blocked");
    expect((callsLog(t.db) as { model: string }[]).map((c) => c.model)).toEqual(["sonnet", "sonnet", "opus"]);
  });

  it("a success resets the consecutive-failure count", async () => {
    const t = setup([() => result({ bad: 1 }), () => result(good(1, { confidence: 0.7 }))]);
    await t.run();
    expect(t.tasks.get(t.task.id).failures).toBe(0);
  });
});

describe("token cap", () => {
  it("warns once at 80% and stops at 100%", async () => {
    const t = setup([() => result(good(1, { confidence: 0.2 }), 850), () => result(good(1, { confidence: 0.2 }), 100), () => result(good(1), 100)], 1000);
    const out = await t.run();
    expect(out).toEqual({ kind: "stopped", reason: "token cap reached" });
    expect(t.tasks.get(t.task.id)).toMatchObject({ status: "stopped", tokens_used: 1050 });
    const warnings = t.events.filter((e) => e.type === "budget");
    expect(warnings).toEqual([{ type: "budget", data: { task_id: t.task.id, percent: 80 } }]);
    expect(t.db.prepare("SELECT COUNT(*) AS n FROM steps WHERE status = 'budget_warning'").get()).toEqual({ n: 1 });
  });

  it("does not start a call when the cap is already used up", async () => {
    const t = setup([], 1000);
    t.tasks.addTokens(t.task.id, 1000);
    expect((await t.run()).kind).toBe("stopped");
    expect(t.q.calls).toHaveLength(0);
  });

  it("respects an owner stop between calls", async () => {
    const t = setup([() => { t.tasks.stop(t.task.id); return result({ bad: 1 }); }]);
    expect(await t.run()).toEqual({ kind: "stopped", reason: "stopped by owner" });
  });
});
