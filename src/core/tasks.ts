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
  created_at: string;
  updated_at: string;
}

export class TaskService {
  constructor(private db: Db, private bus?: EventBus) {}

  create(projectId: number, description: string): Task {
    const info = this.db.prepare("INSERT INTO tasks (project_id, description) VALUES (?, ?)").run(projectId, description);
    const id = Number(info.lastInsertRowid);
    this.db.prepare("INSERT INTO steps (task_id, agent, status, to_status, summary) VALUES (?, 'system', 'done', 'received', 'task created')").run(id);
    const task = this.get(id);
    this.bus?.publish({ type: "task", data: { id, status: task.status } });
    return task;
  }

  get(id: number): Task {
    const t = this.db.prepare("SELECT id, project_id, description, status, branch, tokens_used, created_at, updated_at FROM tasks WHERE id = ?").get(id) as Task | undefined;
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
      .prepare("SELECT id, project_id, description, status, branch, tokens_used, created_at, updated_at FROM tasks WHERE status IN ('received','planning','in_progress') ORDER BY id")
      .all() as Task[];
  }
}
