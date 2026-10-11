import type { EventBus } from "../api/events.js";
import type { Db } from "../db/index.js";

export const TASK_STATUSES = ["received", "planning", "in_progress", "awaiting_approval", "merged", "blocked", "stopped"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Allowed transitions. `merged` and `stopped` are terminal. */
const TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  received: ["planning", "blocked", "stopped"],
  planning: ["in_progress", "awaiting_approval", "blocked", "stopped"],
  in_progress: ["awaiting_approval", "blocked", "stopped"],
  awaiting_approval: ["in_progress", "merged", "blocked", "stopped"],
  blocked: ["planning", "in_progress", "stopped"],
  merged: [],
  stopped: [],
};

export class InvalidTransitionError extends Error {
  constructor(readonly from: TaskStatus, readonly to: TaskStatus) {
    super(`Invalid task transition: ${from} -> ${to}`);
  }
}

export class NotFoundError extends Error {}

export interface Task {
  id: number;
  project_id: number;
  description: string;
  status: TaskStatus;
  branch: string | null;
  tokens_used: number;
  failures: number;
  escalations: number;
  flagged: number;
  created_at: string;
  updated_at: string;
}

const TASK_COLS = "id, project_id, description, status, branch, tokens_used, failures, escalations, flagged, created_at, updated_at";

export class TaskService {
  constructor(private db: Db, private bus?: EventBus) {}

  create(projectId: number, description: string, flagged = false): Task {
    const info = this.db.prepare("INSERT INTO tasks (project_id, description, flagged) VALUES (?, ?, ?)").run(projectId, description, flagged ? 1 : 0);
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
  transition(id: number, to: TaskStatus, summary?: string): Task {
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
    return task;
  }

  /** Stops a task immediately from any non-terminal state. */
  stop(id: number): Task {
    return this.transition(id, "stopped", "stopped by owner");
  }

  /** Tasks that were mid-flight and should be picked up again after a restart. */
  resumable(): Task[] {
    return this.db
      .prepare(`SELECT ${TASK_COLS} FROM tasks WHERE status IN ('received','planning','in_progress') ORDER BY id`)
      .all() as Task[];
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
}
