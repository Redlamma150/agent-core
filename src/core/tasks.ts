import type { EventBus } from "../api/events.js";
import type { Db } from "../db/index.js";

export const TASK_STATUSES = ["received", "planning", "in_progress", "awaiting_approval", "merged", "blocked", "stopped"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Allowed transitions. `merged` is final; `stopped` can only be resumed by the owner (continue). */
const TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  received: ["planning", "blocked", "stopped"],
  planning: ["in_progress", "awaiting_approval", "blocked", "stopped"],
  in_progress: ["awaiting_approval", "blocked", "stopped"],
  awaiting_approval: ["in_progress", "merged", "blocked", "stopped"],
  blocked: ["planning", "in_progress", "stopped"],
  merged: [],
  stopped: ["planning", "in_progress"],
};

export class InvalidTransitionError extends Error {
  constructor(readonly from: TaskStatus, readonly to: TaskStatus) {
    super(`Invalid task transition: ${from} -> ${to}`);
  }
}

export class NotFoundError extends Error {}

/** An action that does not fit the task's current state (e.g. deleting a running task). */
export class InvalidActionError extends Error {}

/** Days a deleted task stays in the trash before it is removed for good. */
export const TRASH_DAYS = 30;

const ACTIVE: readonly TaskStatus[] = ["received", "planning", "in_progress", "awaiting_approval"];
const EDITABLE: readonly TaskStatus[] = ["received", "blocked", "stopped"];
const SETTLED: readonly TaskStatus[] = ["merged", "stopped"];

const titleOf = (description: string) => (description.split("\n")[0] ?? "").trim().slice(0, 80);

export interface Task {
  id: number;
  project_id: number;
  description: string;
  status: TaskStatus;
  branch: string | null;
  base_branch: string | null;
  tokens_used: number;
  failures: number;
  escalations: number;
  flagged: number;
  title: string | null;
  archived_at: string | null;
  deleted_at: string | null;
  /** Set while the task's merge has been undone with a revert commit (the task stays `merged`). */
  reverted_at: string | null;
  /** UTC time ("YYYY-MM-DD HH:MM:SS") a scheduled task is waiting for. Null once it starts. */
  scheduled_for: string | null;
  token_extra: number;
  created_at: string;
  updated_at: string;
}

/** SQLite's own UTC text format, which the rest of the schema uses. */
export const sqliteTime = (d: Date): string => d.toISOString().slice(0, 19).replace("T", " ");

const TASK_COLS = "id, project_id, description, status, branch, base_branch, tokens_used, failures, escalations, flagged, title, archived_at, deleted_at, reverted_at, scheduled_for, token_extra, created_at, updated_at";

export class TaskService {
  constructor(private db: Db, private bus?: EventBus) {}

  create(projectId: number, description: string, flagged = false, scheduledFor: Date | null = null): Task {
    const info = this.db
      .prepare("INSERT INTO tasks (project_id, description, flagged, title, scheduled_for) VALUES (?, ?, ?, ?, ?)")
      .run(projectId, description, flagged ? 1 : 0, titleOf(description), scheduledFor ? sqliteTime(scheduledFor) : null);
    const id = Number(info.lastInsertRowid);
    this.db.prepare("INSERT INTO steps (task_id, agent, status, to_status, summary) VALUES (?, 'system', 'done', 'received', 'task created')").run(id);
    const task = this.get(id);
    this.bus?.publish({ type: "task", data: { id, status: task.status } });
    return task;
  }

  get(id: number): Task {
    const t = this.db.prepare(`SELECT ${TASK_COLS} FROM tasks WHERE id = ?`).get(id) as Task | undefined;
    if (!t) throw new NotFoundError(`Task ${id} not found`);
    return t;
  }

  /**
   * Moves a task to a new state. The status change and its audit row in `steps` are written in one
   * transaction, guarded on the current status so two concurrent callers cannot both win.
   */
  /**
   * `notice` is a short Hebrew reason for the owner's push notification (blocked tasks). `summary` is the technical
   * audit line and may be in English or contain details that must not appear on a lock screen.
   */
  transition(id: number, to: TaskStatus, summary?: string, notice?: string): Task {
    const apply = this.db.transaction(() => {
      const from = this.get(id).status;
      if (!TRANSITIONS[from].includes(to)) throw new InvalidTransitionError(from, to);
      const res = this.db.prepare("UPDATE tasks SET status = ?, updated_at = datetime('now') WHERE id = ? AND status = ?").run(to, id, from);
      if (res.changes !== 1) throw new InvalidTransitionError(from, to);
      this.db
        .prepare("INSERT INTO steps (task_id, agent, status, from_status, to_status, summary) VALUES (?, 'system', 'done', ?, ?, ?)")
        .run(id, from, to, summary ?? null);
    });
    apply();
    const task = this.get(id);
    this.bus?.publish({ type: "task", data: { id, status: task.status } });
    // A separate event, only for the moment a task gets stuck: the owner is notified once, not on every later edit.
    if (to === "blocked") this.bus?.publish({ type: "blocked", data: { task_id: id, reason: notice ?? "" } });
    if (to === "merged") this.bus?.publish({ type: "merged", data: { task_id: id } });
    return task;
  }

  /** Stops a task immediately from any non-terminal state. */
  stop(id: number): Task {
    const task = this.transition(id, "stopped", "stopped by owner");
    this.bus?.publish({ type: "stopped", data: { task_id: id } }); // only the owner's stop: the token cap has its own alert
    return task;
  }

  /** Tasks that were mid-flight and should be picked up again after a restart. */
  resumable(): Task[] {
    return this.db
      .prepare(`SELECT ${TASK_COLS} FROM tasks WHERE status IN ('received','planning','in_progress') AND scheduled_for IS NULL ORDER BY id`)
      .all() as Task[];
  }

  /** The owner starts a scheduled task now (or its time came): it no longer waits. */
  clearSchedule(id: number): void {
    this.db.prepare("UPDATE tasks SET scheduled_for = NULL WHERE id = ?").run(id);
    this.changed(id);
  }

  setBranch(id: number, branch: string, base: string): void {
    this.db.prepare("UPDATE tasks SET branch = ?, base_branch = ? WHERE id = ?").run(branch, base, id);
  }

  /** Counts one more consecutive failure and returns the new count. */
  recordFailure(id: number): number {
    this.db.prepare("UPDATE tasks SET failures = failures + 1, updated_at = datetime('now') WHERE id = ?").run(id);
    return this.get(id).failures;
  }

  resetFailures(id: number): void {
    this.db.prepare("UPDATE tasks SET failures = 0 WHERE id = ?").run(id);
  }

  /** An escalation starts the task fresh on the stronger model, so the consecutive-failure count restarts. */
  recordEscalation(id: number): number {
    this.db.prepare("UPDATE tasks SET escalations = escalations + 1, failures = 0 WHERE id = ?").run(id);
    return this.get(id).escalations;
  }

  addTokens(id: number, tokens: number): number {
    this.db.prepare("UPDATE tasks SET tokens_used = tokens_used + ? WHERE id = ?").run(tokens, id);
    return this.get(id).tokens_used;
  }

  /** Writes a non-transition audit line (escalation, budget warning) to the task's step log. */
  note(id: number, status: string, summary: string): void {
    this.db.prepare("INSERT INTO steps (task_id, agent, status, summary) VALUES (?, 'system', ?, ?)").run(id, status, summary);
  }

  hasNote(id: number, status: string): boolean {
    return this.db.prepare("SELECT 1 FROM steps WHERE task_id = ? AND status = ? LIMIT 1").get(id, status) !== undefined;
  }

  addTokenExtra(id: number, tokens: number): void {
    this.db.prepare("UPDATE tasks SET token_extra = token_extra + ? WHERE id = ?").run(tokens, id);
  }

  /** Edits the text of a task that is not running. Without an explicit title the title follows the description. */
  update(id: number, changes: { title?: string; description?: string }): Task {
    const task = this.get(id);
    if (!EDITABLE.includes(task.status)) throw new InvalidActionError(`cannot edit a task that is ${task.status}`);
    const description = changes.description ?? task.description;
    const title = changes.title ?? (changes.description !== undefined ? titleOf(description) : task.title);
    this.db.prepare("UPDATE tasks SET description = ?, title = ?, updated_at = datetime('now') WHERE id = ?").run(description, title, id);
    this.note(id, "edited", "task text edited by owner");
    return this.changed(id);
  }

  /** Marks a merged task as reverted, or clears the mark when the revert itself is undone. */
  setReverted(id: number, reverted: boolean): Task {
    const task = this.get(id);
    if (task.status !== "merged") throw new InvalidActionError("only a merged task can be reverted");
    this.db.prepare("UPDATE tasks SET reverted_at = ? WHERE id = ?").run(reverted ? new Date().toISOString().slice(0, 19).replace("T", " ") : null, id);
    this.note(id, reverted ? "reverted" : "revert_undone", reverted ? "המיזוג הוחזר" : "המיזוג הוחזר למקומו");
    return this.changed(id);
  }

  /** Moves a finished or parked task to the trash. Running tasks must be stopped first. */
  trash(id: number): Task {
    const task = this.get(id);
    if (ACTIVE.includes(task.status)) throw new InvalidActionError("stop the task before deleting it");
    this.db.prepare("UPDATE tasks SET deleted_at = datetime('now') WHERE id = ?").run(id);
    return this.changed(id);
  }

  restore(id: number): Task {
    this.get(id);
    this.db.prepare("UPDATE tasks SET deleted_at = NULL WHERE id = ?").run(id);
    return this.changed(id);
  }

  /** Hides a finished task from the main lists without deleting it. */
  archive(id: number, archived = true): Task {
    const task = this.get(id);
    if (archived && !SETTLED.includes(task.status)) throw new InvalidActionError("only finished or stopped tasks can be archived");
    this.db.prepare("UPDATE tasks SET archived_at = ? WHERE id = ?").run(archived ? new Date().toISOString().slice(0, 19).replace("T", " ") : null, id);
    return this.changed(id);
  }

  /** Removes tasks that have sat in the trash for longer than TRASH_DAYS. Usage history (llm_calls) is kept, detached from the task. */
  purgeTrashed(days = TRASH_DAYS): number {
    const old = this.db.prepare("SELECT id FROM tasks WHERE deleted_at IS NOT NULL AND deleted_at < datetime('now', ?)").all(`-${days} days`) as { id: number }[];
    const purge = this.db.transaction((ids: number[]) => {
      for (const id of ids) {
        this.db.prepare("UPDATE llm_calls SET task_id = NULL WHERE task_id = ?").run(id);
        for (const table of ["activity", "attachments", "approvals", "steps"]) this.db.prepare(`DELETE FROM ${table} WHERE task_id = ?`).run(id);
        this.db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
      }
    });
    purge(old.map((r) => r.id));
    return old.length;
  }

  private changed(id: number): Task {
    const task = this.get(id);
    this.bus?.publish({ type: "task", data: { id, status: task.status } });
    return task;
  }
}
