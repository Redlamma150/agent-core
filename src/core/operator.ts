import { mkdirSync } from "node:fs";
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { MODEL_BY_ROLE } from "../agents/router.js";
import type { AgentRunner } from "../agents/runner.js";
import { loadTemplate } from "../agents/templates.js";
import type { Db } from "../db/index.js";
import type { TaskDriver } from "./pipeline.js";
import type { TaskService } from "./tasks.js";

export const SERVER_NAME = "ops";

export interface ChatTurn {
  from: "me" | "system";
  text: string;
}

/** What the operator did during one chat message; the app shows these as links under the reply. */
export interface OperatorAction {
  type: "created" | "stopped" | "continued";
  task_id: number;
}

export interface ChatReply {
  reply: string;
  actions: OperatorAction[];
}

export class OperatorBusyError extends Error {}
export class OperatorFailedError extends Error {}

export const MAX_HISTORY = 10;
export const MAX_TEXT = 2000;

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const ok = (data: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(data) }] });
const fail = (message: string): ToolResult => ({ content: [{ type: "text", text: message }], isError: true });

const firstLine = (text: string) => (text.split("\n")[0] ?? "").trim().slice(0, 100);

/**
 * The operator's whole toolbox. It can look things up and start, stop or continue tasks, nothing more: no files,
 * no shell, no web, and deliberately no approve, reject, merge or delete. Approving stays a tap by the owner.
 * Everything it reads from tasks is data written by other agents, which the prompt tells it never to obey.
 */
export function operatorTools(deps: { db: Db; tasks: TaskService; driver: TaskDriver }, actions: OperatorAction[]) {
  const { db, tasks, driver } = deps;
  const taskRow = (id: number) =>
    db.prepare("SELECT t.id, p.name AS project, t.title, t.description, t.status, t.tokens_used, t.updated_at, (SELECT summary FROM steps WHERE task_id = t.id AND to_status IN ('blocked','stopped') ORDER BY id DESC LIMIT 1) AS reason FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = ?").get(id) as
      | { id: number; project: string; title: string | null; description: string; status: string; tokens_used: number; updated_at: string; reason: string | null }
      | undefined;
  const brief = (r: NonNullable<ReturnType<typeof taskRow>>) => ({ id: r.id, project: r.project, title: r.title ?? firstLine(r.description), status: r.status, tokens_used: r.tokens_used, updated_at: r.updated_at, reason: r.reason });

  const handlers = {
    list_tasks: async (a: { status?: string; limit?: number }): Promise<ToolResult> => {
      const rows = db
        .prepare(`SELECT t.id FROM tasks t WHERE t.deleted_at IS NULL AND t.archived_at IS NULL ${a.status ? "AND t.status = ?" : ""} ORDER BY t.id DESC LIMIT ?`)
        .all(...(a.status ? [a.status, a.limit ?? 15] : [a.limit ?? 15])) as { id: number }[];
      return ok(rows.map((r) => brief(taskRow(r.id)!)));
    },
    get_task: async (a: { id: number }): Promise<ToolResult> => {
      const r = taskRow(a.id);
      if (!r) return fail(`task ${a.id} not found`);
      const steps = db.prepare("SELECT agent, status, to_status, summary, created_at FROM steps WHERE task_id = ? ORDER BY id DESC LIMIT 8").all(a.id);
      return ok({ ...brief(r), description: r.description.slice(0, 1500), recent_steps: steps });
    },
    list_approvals: async (): Promise<ToolResult> =>
      ok(db.prepare("SELECT id, task_id, substr(request_text, 1, 600) AS request_text, created_at FROM approvals WHERE status = 'pending' ORDER BY id").all()),
    list_projects: async (): Promise<ToolResult> => ok(db.prepare("SELECT id, name FROM projects ORDER BY name").all()),
    usage: async (): Promise<ToolResult> => {
      const since = (m: string) => db.prepare("SELECT COUNT(*) AS calls, COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens FROM llm_calls WHERE created_at >= datetime('now', ?)").get(m);
      return ok({ last_5h: since("-5 hours"), last_24h: since("-24 hours"), last_7d: since("-7 days") });
    },
    create_task: async (a: { project_id: number; description: string; flagged?: boolean }): Promise<ToolResult> => {
      if (!db.prepare("SELECT 1 FROM projects WHERE id = ?").get(a.project_id)) return fail(`project ${a.project_id} not found`);
      const task = tasks.create(a.project_id, a.description.trim(), a.flagged);
      driver.start(task.id);
      actions.push({ type: "created", task_id: task.id });
      return ok({ created: task.id, status: "the task is queued and an agent will start on it" });
    },
    stop_task: async (a: { id: number }): Promise<ToolResult> => {
      try {
        driver.stop(a.id);
        actions.push({ type: "stopped", task_id: a.id });
        return ok({ stopped: a.id });
      } catch (err) {
        return fail((err as Error).message);
      }
    },
    continue_task: async (a: { id: number; note?: string }): Promise<ToolResult> => {
      try {
        driver.continueTask(a.id, a.note);
        actions.push({ type: "continued", task_id: a.id });
        return ok({ continued: a.id });
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  };
  return handlers;
}

/** The handlers as an in-process MCP server for the Agent SDK. */
export function operatorServer(deps: { db: Db; tasks: TaskService; driver: TaskDriver }, actions: OperatorAction[]): McpSdkServerConfigWithInstance {
  const h = operatorTools(deps, actions);
  return createSdkMcpServer({
    name: SERVER_NAME,
    tools: [
      tool("list_tasks", "List recent tasks (not archived or deleted), newest first. Optional status filter: received, planning, in_progress, awaiting_approval, merged, blocked, stopped.", { status: z.string().optional(), limit: z.number().int().min(1).max(30).optional() }, (a) => h.list_tasks(a)),
      tool("get_task", "One task in detail: description, status, why it stopped, and its latest steps.", { id: z.number().int().positive() }, (a) => h.get_task(a)),
      tool("list_approvals", "Approval requests that are waiting for the owner.", {}, () => h.list_approvals()),
      tool("list_projects", "The registered projects (id and name).", {}, () => h.list_projects()),
      tool("usage", "Token usage over the last 5 hours, 24 hours and 7 days.", {}, () => h.usage()),
      tool("create_task", "Start a new task in a project. Only when the owner clearly asked for work to be done. `flagged` runs it on the stronger model (for sensitive or complex work).", { project_id: z.number().int().positive(), description: z.string().min(1).max(5000), flagged: z.boolean().optional() }, (a) => h.create_task(a)),
      tool("stop_task", "Stop a running task right away. Only when the owner asked.", { id: z.number().int().positive() }, (a) => h.stop_task(a)),
      tool("continue_task", "Continue a blocked or stopped task, optionally with a note for the agents. Only when the owner asked.", { id: z.number().int().positive(), note: z.string().max(2000).optional() }, (a) => h.continue_task(a)),
    ],
  });
}

export const TOOL_NAMES = ["list_tasks", "get_task", "list_approvals", "list_projects", "usage", "create_task", "stop_task", "continue_task"];

/** The owner's free-text chat. One message at a time: each one is a full agent call and costs tokens. */
export class OperatorService {
  private busy = false;
  private cwd: string;

  constructor(private d: { db: Db; tasks: TaskService; driver: TaskDriver; runner: AgentRunner }, workDir: string) {
    this.cwd = workDir;
  }

  async chat(text: string, history: ChatTurn[] = []): Promise<ChatReply> {
    if (this.busy) throw new OperatorBusyError("the operator is answering another message");
    this.busy = true;
    try {
      mkdirSync(this.cwd, { recursive: true });
      const actions: OperatorAction[] = [];
      const recent = history.slice(-MAX_HISTORY).map((t) => `${t.from === "me" ? "Owner" : "Operator"}: ${t.text.slice(0, MAX_TEXT)}`);
      const prompt = `${recent.length > 0 ? `Conversation so far:\n${recent.join("\n")}\n\n` : ""}The owner's new message:\n${text.slice(0, MAX_TEXT)}`;
      const res = await this.d.runner.run({
        taskId: null,
        role: "operator",
        model: MODEL_BY_ROLE.operator,
        prompt,
        systemPrompt: loadTemplate("operator"),
        cwd: this.cwd,
        tools: [], // no built-in tools at all: no files, no shell, no web
        allowedTools: TOOL_NAMES.map((n) => `mcp__${SERVER_NAME}__${n}`),
        mcpServers: { [SERVER_NAME]: operatorServer(this.d, actions) },
        permissionMode: "dontAsk",
        maxTurns: 10,
      });
      if (!res.ok) throw new OperatorFailedError(res.reason);
      if (res.handoff.status === "failed") throw new OperatorFailedError(res.handoff.summary);
      return { reply: res.handoff.summary, actions };
    } finally {
      this.busy = false;
    }
  }
}
