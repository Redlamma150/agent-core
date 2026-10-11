import { executeAgent } from "../agents/execute.js";
import type { Handoff } from "../agents/contract.js";
import type { AgentRunner } from "../agents/runner.js";
import { BUILDER_ALLOWED, BUILDER_TOOLS, loadTemplate, PLANNER_TOOLS } from "../agents/templates.js";
import type { Db } from "../db/index.js";
import type { Approval, ApprovalService } from "./approvals.js";
import type { BudgetService } from "./budget.js";
import { SecretFileError, type GitService } from "./git.js";
import type { Task, TaskService } from "./tasks.js";

interface ProjectRow {
  id: number;
  name: string;
  repo_path: string;
}

/** What the API needs from the pipeline. */
export interface TaskDriver {
  start(taskId: number): void;
  stop(taskId: number): Task;
  resolveApproval(approvalId: number, approve: boolean, note?: string): Promise<Approval>;
}

const TERMINAL = new Set(["merged", "stopped"]);

/**
 * Runs a task end to end: planner (read-only) -> builder on branch `task-<id>` -> approval request.
 * Approve merges the branch, reject sends the notes back to the builder. Tasks run one at a time.
 */
export class Pipeline implements TaskDriver {
  private active = new Map<number, AbortController>();
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private d: { db: Db; tasks: TaskService; approvals: ApprovalService; runner: AgentRunner; budget: BudgetService; git: GitService },
    private log: (line: string) => void = console.log,
  ) {}

  start(taskId: number, notes?: string): void {
    this.queue = this.queue.then(async () => {
      const abort = new AbortController();
      this.active.set(taskId, abort);
      try {
        await this.drive(taskId, abort.signal, notes);
      } catch (err) {
        this.fail(taskId, err);
      } finally {
        this.active.delete(taskId);
      }
    });
  }

  /** Resolves when every queued task run has finished (used by tests and graceful shutdown). */
  idle(): Promise<void> {
    return this.queue;
  }

  /** Picks up tasks that were mid-flight when the core restarted. */
  resume(): number {
    const tasks = this.d.tasks.resumable();
    tasks.forEach((t) => this.start(t.id));
    return tasks.length;
  }

  stop(taskId: number): Task {
    const task = this.d.tasks.stop(taskId);
    this.active.get(taskId)?.abort();
    return task;
  }

  /** Approve merges the branch first: if the merge fails, the approval stays pending and the error reaches the owner. */
  async resolveApproval(approvalId: number, approve: boolean, note?: string): Promise<Approval> {
    const { tasks, approvals, git } = this.d;
    const approval = approvals.get(approvalId);
    const task = tasks.get(approval.task_id);
    if (approve && approval.status === "pending") {
      if (!task.base_branch) throw new Error(`task ${task.id} has no base branch recorded`);
      await git.merge(this.project(task).repo_path, task.id, task.base_branch);
    }
    const resolved = approvals.resolve(approvalId, approve, note);
    if (!approve) this.start(task.id, note);
    return resolved;
  }

  // ---- internals -------------------------------------------------------------------------------------------------

  private async drive(taskId: number, signal: AbortSignal, notes?: string): Promise<void> {
    const { tasks } = this.d;
    let task = tasks.get(taskId);
    if (TERMINAL.has(task.status) || task.status === "blocked" || task.status === "awaiting_approval") return;

    let plan: Handoff | null = null;
    if (task.status === "received") task = tasks.transition(taskId, "planning");
    if (task.status === "planning") {
      plan = await this.plan(task, signal);
      if (!plan) return; // blocked or stopped; already recorded
      task = tasks.transition(taskId, "in_progress", "plan ready");
    }
    plan ??= this.savedPlan(taskId);
    await this.build(task, plan, notes ?? this.lastRejectionNote(taskId), signal);
  }

  private async plan(task: Task, signal: AbortSignal): Promise<Handoff | null> {
    const project = this.project(task);
    const out = await executeAgent(this.d, {
      taskId: task.id,
      role: "planner",
      systemPrompt: loadTemplate("planner"),
      prompt: `Task ${task.id}: ${task.description}\n\nThe project "${project.name}" is your current directory. Plan this task.`,
      cwd: project.repo_path,
      tools: PLANNER_TOOLS,
      allowedTools: PLANNER_TOOLS,
      permissionMode: "dontAsk",
      maxTurns: 20,
      signal,
    });
    if (out.kind !== "completed") return null;
    this.d.db
      .prepare("INSERT INTO steps (task_id, agent, status, summary, handoff) VALUES (?, 'planner', 'done', ?, ?)")
      .run(task.id, out.handoff.summary, JSON.stringify(out.handoff));
    return out.handoff;
  }

  private async build(task: Task, plan: Handoff | null, notes: string | undefined, signal: AbortSignal): Promise<void> {
    const { tasks, approvals, git } = this.d;
    const project = this.project(task);
    const prepared = await git.prepare(project.repo_path, task.id, task.base_branch);
    tasks.setBranch(task.id, prepared.branch, prepared.base);

    const parts = [`Task ${task.id}: ${task.description}`];
    if (plan) parts.push(`Plan from the planner:\n${plan.summary}\nSteps:\n${plan.open_items.map((s, i) => `${i + 1}. ${s}`).join("\n")}`);
    if (notes) parts.push(`The owner rejected the previous attempt with these notes. Address all of them:\n${notes}`);
    parts.push("Your current directory is the task's git worktree. Implement the task there.");

    const out = await executeAgent(this.d, {
      taskId: task.id,
      role: "builder",
      systemPrompt: loadTemplate("builder"),
      prompt: parts.join("\n\n"),
      cwd: prepared.worktree,
      tools: BUILDER_TOOLS,
      allowedTools: BUILDER_ALLOWED,
      permissionMode: "dontAsk",
      maxTurns: 40,
      signal,
    });
    if (out.kind !== "completed") return;

    try {
      await git.commitAll(prepared.worktree, `task-${task.id}: ${task.description.split("\n")[0]?.slice(0, 60) ?? ""}`);
    } catch (err) {
      if (err instanceof SecretFileError) return void tasks.transition(task.id, "blocked", err.message);
      throw err;
    }
    const files = await git.changedFiles(project.repo_path, prepared.base, prepared.branch);
    if (files.length === 0) return void tasks.transition(task.id, "blocked", "הבונה סיים בלי לשנות שום קובץ");

    const lines = [`הבונה סיים את משימה #${task.id} בענף ${prepared.branch}.`, out.handoff.summary, `קבצים ששונו (${files.length}): ${files.join(", ")}`];
    if (out.handoff.open_items.length > 0) lines.push(`שים לב: ${out.handoff.open_items.join("; ")}`);
    if (plan?.needs_approval) lines.push("המתכנן סימן את המשימה כרגישה, כדאי לבדוק היטב לפני אישור.");
    approvals.request(task.id, lines.join("\n"));
  }

  private project(task: Task): ProjectRow {
    const p = this.d.db.prepare("SELECT id, name, repo_path FROM projects WHERE id = ?").get(task.project_id) as ProjectRow | undefined;
    if (!p) throw new Error(`project ${task.project_id} not found`);
    return p;
  }

  private savedPlan(taskId: number): Handoff | null {
    const row = this.d.db.prepare("SELECT handoff FROM steps WHERE task_id = ? AND agent = 'planner' AND handoff IS NOT NULL ORDER BY id DESC LIMIT 1").get(taskId) as { handoff: string } | undefined;
    return row ? (JSON.parse(row.handoff) as Handoff) : null;
  }

  private lastRejectionNote(taskId: number): string | undefined {
    const row = this.d.db.prepare("SELECT notes FROM approvals WHERE task_id = ? AND status = 'rejected' ORDER BY id DESC LIMIT 1").get(taskId) as { notes: string | null } | undefined;
    return row?.notes ?? undefined;
  }

  /** Any unexpected error parks the task as blocked with the reason, instead of leaving it half-done. */
  private fail(taskId: number, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.log(`task ${taskId} failed: ${message}`);
    try {
      const status = this.d.tasks.get(taskId).status;
      if (!TERMINAL.has(status) && status !== "blocked") this.d.tasks.transition(taskId, "blocked", `error: ${message}`);
    } catch {
      // the task vanished or is already final: nothing more to record
    }
  }
}
