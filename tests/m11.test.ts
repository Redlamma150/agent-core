import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { AgentRunner, type QueryFn } from "../src/agents/runner.js";
import { buildApp } from "../src/api/server.js";
import { OperatorBusyError, OperatorFailedError, OperatorService, operatorTools, TOOL_NAMES, type OperatorAction } from "../src/core/operator.js";
import { TaskService } from "../src/core/tasks.js";
import { openDb } from "../src/db/index.js";
import { services } from "./api.test.js";

const TOKEN = "t".repeat(40);
const auth = { authorization: `Bearer ${TOKEN}` };

const handoff = (summary: string, over: Record<string, unknown> = {}) => ({
  task_id: "0", agent: "operator", status: "done", summary, artifacts: [], open_items: [], needs_approval: false, confidence: 0.9, ...over,
});
const result = (structured: unknown): SDKMessage =>
  ({ type: "result", subtype: "success", is_error: false, result: "", structured_output: structured, modelUsage: { m: { inputTokens: 50, outputTokens: 20, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 } } }) as unknown as SDKMessage;

function setup(reply: () => Promise<SDKMessage> | SDKMessage = () => result(handoff("הכול רגוע"))) {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO projects (name, repo_path) VALUES ('אתר', '/r')").run();
  const s = services(db);
  const calls: { prompt: string; options: Options }[] = [];
  const queryFn: QueryFn = async function* (params) {
    calls.push(params);
    yield await reply();
  };
  const runner = new AgentRunner(db, s.tasks, queryFn);
  const operator = new OperatorService({ db, tasks: s.tasks, driver: s.driver, runner }, join(tmpdir(), "operator-test"));
  return { db, s, calls, operator };
}

describe("operator tools", () => {
  it("looks things up, starts, stops and continues tasks, and records what it did", async () => {
    const { db, s } = setup();
    const actions: OperatorAction[] = [];
    const t = operatorTools({ db, tasks: s.tasks, driver: s.driver }, actions);

    const created = JSON.parse((await t.create_task({ project_id: 1, description: "  לבנות עמוד  " })).content[0]!.text) as { created: number };
    expect(s.started).toContain(created.created);
    expect(s.tasks.get(created.created).description).toBe("לבנות עמוד");
    expect((await t.create_task({ project_id: 99, description: "x" })).isError).toBe(true);

    const listed = JSON.parse((await t.list_tasks({})).content[0]!.text) as { id: number; project: string }[];
    expect(listed[0]).toMatchObject({ id: created.created, project: "אתר" });
    expect((await t.get_task({ id: 999 })).isError).toBe(true);
    expect(JSON.parse((await t.get_task({ id: created.created })).content[0]!.text)).toMatchObject({ id: created.created, status: "received" });

    s.tasks.transition(created.created, "blocked", "needs a decision");
    expect((await t.continue_task({ id: created.created })).isError).toBeFalsy();
    expect((await t.stop_task({ id: created.created })).isError).toBeFalsy();
    expect((await t.stop_task({ id: 999 })).isError).toBe(true); // an unknown task is reported to the model, not thrown
    expect(actions.map((a) => a.type)).toEqual(["created", "continued", "stopped"]);
    expect(JSON.parse((await t.usage()).content[0]!.text)).toHaveProperty("last_5h");
    expect(JSON.parse((await t.list_projects()).content[0]!.text)).toEqual([{ id: 1, name: "אתר" }]);
    expect(JSON.parse((await t.list_approvals()).content[0]!.text)).toEqual([]);
  });

  it("has no tool that approves, rejects, merges or deletes", () => {
    expect(TOOL_NAMES).toEqual(["list_tasks", "get_task", "list_approvals", "list_projects", "usage", "create_task", "stop_task", "continue_task"]);
    expect(TOOL_NAMES.join(" ")).not.toMatch(/approv.*(resolve|decide)|reject|merge|delete|trash/);
  });
});

describe("operator service", () => {
  it("answers through the agent with only its own tools, and logs the call without a task", async () => {
    const { db, calls, operator } = setup();
    const out = await operator.chat("מה המצב?", [{ from: "me", text: "היי" }, { from: "system", text: "שלום" }]);
    expect(out).toEqual({ reply: "הכול רגוע", actions: [] });
    const { options, prompt } = calls[0]!;
    expect(options.tools).toEqual([]); // no built-in tools: no files, shell or web
    expect(options.allowedTools).toEqual(TOOL_NAMES.map((n) => `mcp__ops__${n}`));
    expect(Object.keys(options.mcpServers ?? {})).toEqual(["ops"]);
    expect(options.strictMcpConfig).toBe(true);
    expect(prompt).toContain("Owner: היי");
    expect(prompt).toContain("Operator: שלום");
    expect(prompt).toContain("מה המצב?");
    expect(db.prepare("SELECT agent, task_id, valid_output FROM llm_calls").all()).toEqual([{ agent: "operator", task_id: null, valid_output: 1 }]);
  });

  it("takes one message at a time", async () => {
    let release!: () => void;
    let held = false;
    const { operator } = setup(() => {
      if (held) return result(handoff("ok")); // only the first call is held back
      held = true;
      return new Promise<SDKMessage>((r) => (release = () => r(result(handoff("ok")))));
    });
    const first = operator.chat("אחת");
    await expect(operator.chat("שתיים")).rejects.toThrow(OperatorBusyError);
    await new Promise((r) => setTimeout(r, 20)); // let the first call reach the agent
    release();
    await first;
    await expect(operator.chat("שלוש")).resolves.toBeDefined(); // free again
  });

  it("reports an invalid or failed answer as a failure", async () => {
    await expect(setup(() => result({ nonsense: true })).operator.chat("x")).rejects.toThrow(OperatorFailedError);
    await expect(setup(() => result(handoff("לא הצלחתי", { status: "failed" }))).operator.chat("x")).rejects.toThrow(OperatorFailedError);
  });
});

describe("POST /chat", () => {
  function api(reply?: () => Promise<SDKMessage> | SDKMessage) {
    const t = setup(reply);
    const app = buildApp({ db: t.db, accessToken: TOKEN, ...t.s, operator: t.operator });
    return { app, ...t };
  }
  const post = (app: ReturnType<typeof api>["app"], payload: unknown) => app.inject({ method: "POST", url: "/chat", headers: auth, payload: payload as object });

  it("returns the reply and the actions", async () => {
    const { app } = api();
    const res = await post(app, { text: "מה קורה?", history: [{ from: "me", text: "היי" }] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ reply: "הכול רגוע", actions: [] });
  });
  it("rejects empty text and over-long history", async () => {
    const { app } = api();
    expect((await post(app, { text: "   " })).statusCode).toBe(400);
    expect((await post(app, { text: "x", history: Array.from({ length: 11 }, () => ({ from: "me", text: "a" })) })).statusCode).toBe(400);
    expect((await post(app, { text: "x", history: [{ from: "robot", text: "a" }] })).statusCode).toBe(400);
  });
  it("answers 429 while busy and 502 when the agent fails, with Hebrew messages", async () => {
    let release!: () => void;
    const busy = api(() => new Promise<SDKMessage>((r) => (release = () => r(result(handoff("ok"))))));
    const first = post(busy.app, { text: "אחת" });
    await new Promise((r) => setTimeout(r, 20));
    const second = await post(busy.app, { text: "שתיים" });
    expect(second.statusCode).toBe(429);
    expect(second.json()).toMatchObject({ error: "busy", message: expect.stringContaining("נסה שוב") });
    release();
    expect((await first).statusCode).toBe(200);

    const failing = api(() => result({ nonsense: true }));
    const res = await post(failing.app, { text: "x" });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: "operator_failed", message: expect.stringContaining("לא הצליח") });
  });
  it("still needs the token", async () => {
    const { app } = api();
    expect((await app.inject({ method: "POST", url: "/chat", payload: { text: "x" } })).statusCode).toBe(401);
  });
});
