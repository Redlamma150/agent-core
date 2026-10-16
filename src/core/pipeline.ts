import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { executeAgent } from "../agents/execute.js";
import type { Handoff } from "../agents/contract.js";
import type { AgentRunner } from "../agents/runner.js";
import { BUILDER_ALLOWED, BUILDER_TOOLS, loadTemplate, PLANNER_TOOLS } from "../agents/templates.js";
import type { Db } from "../db/index.js";
import type { ActivityService } from "./activity.js";
import type { MediaService } from "./media.js";
import type { Approval, ApprovalService } from "./approvals.js";
import type { BudgetService } from "./budget.js";
import { MergeError, SecretFileError, type FileChange, type GitService } from "./git.js";
import type { ScreenshotService } from "./screenshots.js";
import type { SettingsService } from "./settings.js";
import { runTests } from "./verify.js";
import { InvalidActionError, type Task, type TaskService } from "./tasks.js";

interface ProjectRow {
  id: number;
  name: string;
  repo_path: string;
  context_file: string | null;
  test_command: string | null;
}

/** What the API needs from the pipeline. */
export interface TaskDriver {
  start(taskId: number): void;
  stop(taskId: number): Task;
  /** Resumes a blocked or stopped task, optionally with a note from the owner for the agents. */
  continueTask(taskId: number, note?: string): Task;
  /** Starts a new task with the same project and text. */
  duplicate(taskId: number): Task;
  /** `stash` (approve only): set the owner's unsaved changes aside for the merge. `warning` says when they could not be put back. */
  resolveApproval(approvalId: number, approve: boolean, note?: string, opts?: { stash?: boolean }): Promise<Approval & { warning?: string }>;
  /** Undoes the merge of a task with a revert commit; `unrevert` merges it back. The task stays `merged`. */
  revert(taskId: number): Promise<Task>;
  unrevert(taskId: number): Promise<Task>;
  /** Where the task's work is on this computer: its worktree while it exists, otherwise the project folder. */
  locate(taskId: number): { path: string; kind: "worktree" | "project"; exists: boolean };
}

const TERMINAL = new Set(["merged", "stopped"]);
const SCREENSHOT_LIMIT_MS = 90_000;

/**
 * Runs a task end to end: planner (read-only) -> builder on branch `task-<id>` -> approval request.
 * Approve merges the branch, reject sends the notes back to the builder. Tasks run one at a time.
 */
export class Pipeline implements TaskDriver {
  private active = new Map<number, AbortController>();
  /** Tasks queued but not started yet, so a second start (double tap) cannot run the same task twice. */
  private waiting = new Set<number>();
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private d: { db: Db; tasks: TaskService; approvals: ApprovalService; runner: AgentRunner; budget: BudgetService; git: GitService; activity?: ActivityService; media?: MediaService; screenshots?: ScreenshotService; settings?: SettingsService; timeoutMs?: number },
    private log: (line: string) => void = console.log,
  ) {}

  start(taskId: number, notes?: string): void {
    if (this.waiting.has(taskId)) return;
    this.waiting.add(taskId);
    this.queue = this.queue.then(async () => {
      this.waiting.delete(taskId);
      const abort = new AbortController();
      this.active.set(taskId, abort);
      let timer: NodeJS.Timeout | undefined;
      // After the time limit the task is blocked and the agent is told to stop. The queue moves on even if the agent
      // ignores that: one hung task must never hold up all the others.
      const timedOut = new Promise<void>((resolve) => {
        const limit = this.d.timeoutMs;
        if (!limit) return;
        timer = setTimeout(() => {
          this.timeOut(taskId, abort, limit);
          resolve();
        }, limit);
      });
      try {
        await Promise.race([this.drive(taskId, abort.signal, notes), timedOut]);
      } catch (err) {
        this.fail(taskId, err);
      } finally {
        clearTimeout(timer);
        this.active.delete(taskId);
      }
    });
  }

  /** The task ran longer than allowed: park it as blocked (the owner gets the "stuck" alert) and abort the agent. */
  private timeOut(taskId: number, abort: AbortController, limitMs: number): void {
    const minutes = Math.max(1, Math.round(limitMs / 60_000));
    this.log(`task ${taskId} exceeded the time limit (${minutes} min)`);
    try {
      const status = this.d.tasks.get(taskId).status;
      if (status === "received" || status === "planning" || status === "in_progress") {
        this.d.tasks.transition(taskId, "blocked", `המשימה רצה יותר מ${minutes === 1 ? "דקה" : `-${minutes} דקות`} ונעצרה. אפשר להמשיך אותה מאותו מקום.`, `חרגה ממגבלת הזמן (${minutes === 1 ? "דקה" : `${minutes} דקות`})`);
      }
    } catch {
      // the task vanished or changed under us: aborting below is still right
    }
    abort.abort();
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

  continueTask(taskId: number, note?: string): Task {
    const { tasks, budget, db } = this.d;
    const task = tasks.get(taskId);
    if (task.status !== "blocked" && task.status !== "stopped") throw new InvalidActionError(`cannot continue a task that is ${task.status}`);
    if (task.deleted_at) throw new InvalidActionError("restore the task from the trash first");
    if (budget.isExhausted(taskId)) budget.grantAllowance(taskId);
    tasks.resetFailures(taskId);
    db.prepare("UPDATE tasks SET escalations = 0 WHERE id = ?").run(taskId);
    const cleanNote = note?.trim() || undefined;
    if (cleanNote) tasks.note(taskId, "owner_note", cleanNote);
    const hasPlan = this.savedPlan(taskId) !== null;
    const resumed = tasks.transition(taskId, hasPlan ? "in_progress" : "planning", cleanNote ? "continued by owner with a note" : "continued by owner");
    this.start(taskId, cleanNote);
    return resumed;
  }

  duplicate(taskId: number): Task {
    const { tasks } = this.d;
    const source = tasks.get(taskId);
    const copy = tasks.create(source.project_id, source.description, source.flagged === 1);
    this.start(copy.id);
    return copy;
  }

  /** Approve merges the branch first: if the merge fails, the approval stays pending and the error reaches the owner. */
  async resolveApproval(approvalId: number, approve: boolean, note?: string, opts: { stash?: boolean } = {}): Promise<Approval & { warning?: string }> {
    const { tasks, approvals, git } = this.d;
    const approval = approvals.get(approvalId);
    const task = tasks.get(approval.task_id);
    let warning: string | undefined;
    if (approve && approval.status === "pending") {
      if (!task.base_branch) throw new Error(`task ${task.id} has no base branch recorded`);
      const stash = opts.stash ?? this.d.settings?.autoStash() ?? false;
      let outcome;
      try {
        outcome = await git.merge(this.project(task).repo_path, task.id, task.base_branch, { stash });
      } catch (err) {
        // Counted by the efficiency suggestions: the same block coming back is worth fixing for good.
        if (err instanceof MergeError && err.reason === "dirty") tasks.note(task.id, "merge_failed_dirty", err.message);
        throw err;
      }
      if (outcome.stashRestored === false) {
        warning = "המשימה מוזגה, אבל השינויים שלא שמרת התנגשו איתה ולא הוחזרו. הם שמורים ב-git stash בפרויקט (git stash pop).";
        tasks.note(task.id, "stash_kept", warning);
      }
    }
    const resolved = approvals.resolve(approvalId, approve, note);
    if (!approve) this.start(task.id, note);
    return warning ? { ...resolved, warning } : resolved;
  }

  async revert(taskId: number): Promise<Task> {
    const { tasks, git } = this.d;
    const task = tasks.get(taskId);
    if (task.status !== "merged") throw new InvalidActionError("only a merged task can be reverted");
    if (task.reverted_at) throw new InvalidActionError("this merge was already reverted");
    if (!task.base_branch) throw new Error(`task ${taskId} has no base branch recorded`);
    const repo = this.project(task).repo_path;
    const commit = await git.findMerge(repo, taskId);
    if (!commit) throw new MergeError("לא מצאתי את הקומיט של המיזוג בפרויקט, ולכן אי אפשר להחזיר אותו אוטומטית.", "missing");
    const revertCommit = await git.revert(repo, commit, task.base_branch);
    this.d.db.prepare("UPDATE tasks SET revert_commit = ? WHERE id = ?").run(revertCommit, taskId);
    return tasks.setReverted(taskId, true);
  }

  async unrevert(taskId: number): Promise<Task> {
    const { tasks, git, db } = this.d;
    const task = tasks.get(taskId);
    if (task.status !== "merged" || !task.reverted_at) throw new InvalidActionError("this merge was not reverted");
    const row = db.prepare("SELECT revert_commit FROM tasks WHERE id = ?").get(taskId) as { revert_commit: string | null };
    if (!row.revert_commit) throw new MergeError("לא מצאתי את קומיט ההחזרה, ולכן אי אפשר לבטל אותו אוטומטית.", "missing");
    await git.revert(this.project(task).repo_path, row.revert_commit, task.base_branch!);
    return tasks.setReverted(taskId, false);
  }

  locate(taskId: number): { path: string; kind: "worktree" | "project"; exists: boolean } {
    const project = this.project(this.d.tasks.get(taskId));
    const worktree = this.d.git.worktreePath(project.repo_path, taskId);
    if (existsSync(worktree)) return { path: worktree, kind: "worktree", exists: true };
    return { path: project.repo_path, kind: "project", exists: existsSync(project.repo_path) };
  }

  // ---- internals -------------------------------------------------------------------------------------------------

  private async drive(taskId: number, signal: AbortSignal, notes?: string): Promise<void> {
    const { tasks } = this.d;
    let task = tasks.get(taskId);
    if (TERMINAL.has(task.status) || task.status === "blocked" || task.status === "awaiting_approval") return;

    let plan: Handoff | null = null;
    if (task.status === "received") task = tasks.transition(taskId, "planning");
    if (task.status === "planning") {
      plan = await this.plan(task, signal, notes);
      if (!plan) return; // blocked or stopped; already recorded
      task = tasks.transition(taskId, "in_progress", "plan ready");
    }
    plan ??= this.savedPlan(taskId);
    await this.build(task, plan, notes ?? this.lastRejectionNote(taskId), signal);
  }

  private async plan(task: Task, signal: AbortSignal, notes?: string): Promise<Handoff | null> {
    const project = this.project(task);
    const out = await executeAgent(this.d, {
      taskId: task.id,
      role: "planner",
      systemPrompt: loadTemplate("planner"),
      prompt: `Task ${task.id}: ${task.description}\n\nThe project "${project.name}" is your current directory. Plan this task.${notes ? `\n\nA note from the owner: ${notes}` : ""}${projectContext(project)}${this.attachmentsNote(task.id)}`,
      cwd: project.repo_path,
      extraDirs: this.attachmentDirs(task.id),
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
    const context = projectContext(project);
    if (context) parts.push(context.trim());
    const attached = this.attachmentsNote(task.id).trim();
    if (attached) parts.push(attached);

    const out = await executeAgent(this.d, {
      taskId: task.id,
      role: "builder",
      systemPrompt: loadTemplate("builder"),
      prompt: parts.join("\n\n"),
      cwd: prepared.worktree,
      extraDirs: this.attachmentDirs(task.id),
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
      if (err instanceof SecretFileError) return void tasks.transition(task.id, "blocked", err.message, "נמצא קובץ שנראה כמו סוד (מפתח או סיסמה), ולכן לא נשמר");
      throw err;
    }
    const files = await git.changedFiles(project.repo_path, prepared.base, prepared.branch);
    if (files.length === 0) return void tasks.transition(task.id, "blocked", "הבונה סיים בלי לשנות שום קובץ", "הסוכן סיים בלי לשנות אף קובץ");

    this.recordChanges(task.id, await git.changeSummary(project.repo_path, prepared.base, prepared.branch).catch(() => []));
    const tests = project.test_command ? await this.verify(task.id, project.test_command, prepared.worktree) : null;

    const lines = [`הבונה סיים את משימה #${task.id} בענף ${prepared.branch}\u200F.`, out.handoff.summary, `קבצים ששונו (${files.length}):\n${files.join("\n")}`];
    if (out.handoff.open_items.length > 0) lines.push(`שים לב: ${out.handoff.open_items.join("; ")}`);
    if (tests) lines.push(tests);
    const shots = await this.capture(task.id, { repo: project.repo_path, base: prepared.base, worktree: prepared.worktree, changedFiles: files });
    if (shots) lines.push(shots);
    if (plan?.needs_approval) lines.push("המתכנן סימן את המשימה כרגישה, כדאי לבדוק היטב לפני אישור.");
    approvals.request(task.id, lines.join("\n"));
  }

  /** Runs the project's tests and records the outcome; a failure does not block the task, the owner sees it in the approval. */
  private async verify(taskId: number, command: string, cwd: string): Promise<string> {
    this.d.activity?.record(taskId, "system", "Tests", null);
    const result = await runTests(command, cwd);
    this.d.tasks.note(taskId, result.passed ? "tests_passed" : "tests_failed", result.summary);
    return result.summary;
  }

  /**
   * Takes before and after screenshots for the approval screen. Best effort: a missing browser or a broken page is
   * recorded in the task history and never blocks the approval.
   */
  private async capture(taskId: number, input: Parameters<ScreenshotService["capture"]>[1]): Promise<string | null> {
    const service = this.d.screenshots;
    if (!service) return null;
    this.d.activity?.record(taskId, "system", "Screenshots", null);
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        service.capture(taskId, input),
        new Promise<never>((_, fail) => (timer = setTimeout(() => fail(new Error("screenshots took too long")), SCREENSHOT_LIMIT_MS))),
      ]);
      if (result.saved.length > 0) this.d.tasks.note(taskId, "screenshots_taken", result.summary);
      return result.summary;
    } catch (err) {
      this.log(`task ${taskId}: screenshots failed: ${err instanceof Error ? err.message : String(err)}`);
      this.d.tasks.note(taskId, "screenshots_failed", "לא הצלחתי לצלם את התוצר");
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Keeps the per file summary with the task, so the approval screen can show it (also after the branch is gone). */
  private recordChanges(taskId: number, changes: FileChange[]): void {
    if (changes.length === 0) return;
    this.d.db.prepare("DELETE FROM steps WHERE task_id = ? AND status = 'files_changed'").run(taskId);
    this.d.db.prepare("INSERT INTO steps (task_id, agent, status, summary, handoff) VALUES (?, 'system', 'files_changed', ?, ?)").run(taskId, `${changes.length} קבצים`, JSON.stringify(changes));
  }

  /** Lists the owner's attached files for the agent's prompt. Paths only; the agent opens them with Read. */
  private attachmentsNote(taskId: number): string {
    const files = this.d.media?.paths(taskId) ?? [];
    if (files.length === 0) return "";
    return `\n\nFiles attached by the owner (images, PDFs or text; open them with the Read tool and use them as reference, do not copy them into the repo unless the task asks for it):\n${files.map((f) => `- ${f.path} (${f.name})`).join("\n")}`;
  }

  private attachmentDirs(taskId: number): string[] | undefined {
    return (this.d.media?.paths(taskId).length ?? 0) > 0 ? [this.d.media!.taskDir(taskId)] : undefined;
  }

  private project(task: Task): ProjectRow {
    const p = this.d.db.prepare("SELECT id, name, repo_path, context_file, test_command FROM projects WHERE id = ?").get(task.project_id) as ProjectRow | undefined;
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
      if (!TERMINAL.has(status) && status !== "blocked") this.d.tasks.transition(taskId, "blocked", `error: ${message}`, "שגיאה לא צפויה בליבה");
    } catch {
      // the task vanished or is already final: nothing more to record
    }
  }
}

const MAX_CONTEXT_CHARS = 20_000;

/**
 * The project's imported context file (decisions, rules for agents), read from the owner's checkout so it
 * reaches the agents even when the file is not committed yet. Must live inside the repository.
 */
export function projectContext(project: { repo_path: string; context_file: string | null }): string {
  if (!project.context_file) return "";
  const root = resolve(project.repo_path);
  const file = resolve(root, project.context_file);
  if (!file.startsWith(root + sep) || !existsSync(file) || !statSync(file).isFile()) return "";
  const text = readFileSync(file, "utf8").slice(0, MAX_CONTEXT_CHARS);
  return `\n\nProject context (${project.context_file}). Follow its rules:\n---\n${text}\n---`;
}
