import type { EventBus } from "../api/events.js";
import type { Db } from "../db/index.js";
import { NotFoundError, type TaskService } from "./tasks.js";

export class AlreadyResolvedError extends Error {}

export interface Approval {
  id: number;
  task_id: number;
  request_text: string;
  status: "pending" | "approved" | "rejected";
  reminders_sent: number;
  notes: string | null;
  created_at: string;
  resolved_at: string | null;
}

export interface ReminderPolicy {
  reminderMinutes: number;
  reminderCount: number;
}

export class ApprovalService {
  constructor(private db: Db, private tasks: TaskService, private policy: ReminderPolicy, private bus?: EventBus) {}

  get(id: number): Approval {
    const a = this.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as Approval | undefined;
    if (!a) throw new NotFoundError(`Approval ${id} not found`);
    return a;
  }

  /** Asks the owner for approval and parks the task in `awaiting_approval`. */
  request(taskId: number, requestText: string, now = new Date()): Approval {
    const create = this.db.transaction(() => {
      this.tasks.transition(taskId, "awaiting_approval", requestText);
      const info = this.db.prepare("INSERT INTO approvals (task_id, request_text, created_at) VALUES (?, ?, ?)").run(taskId, requestText, now.toISOString());
      return Number(info.lastInsertRowid);
    });
    const approval = this.get(create());
    this.bus?.publish({ type: "approval", data: { id: approval.id, task_id: taskId, status: "pending" } });
    return approval;
  }

  /** Approve moves the task to `merged` (the actual git merge arrives in M6); reject sends it back to `in_progress` with the notes. */
  resolve(id: number, approved: boolean, notes?: string, now = new Date()): Approval {
    const run = this.db.transaction(() => {
      const a = this.get(id);
      if (a.status !== "pending") throw new AlreadyResolvedError(`Approval ${id} is already ${a.status}`);
      const res = this.db
        .prepare("UPDATE approvals SET status = ?, notes = ?, resolved_at = ? WHERE id = ? AND status = 'pending'")
        .run(approved ? "approved" : "rejected", notes ?? null, now.toISOString(), id);
      if (res.changes !== 1) throw new Error(`Approval ${id} was resolved concurrently`);
      this.tasks.transition(a.task_id, approved ? "merged" : "in_progress", approved ? "approved" : `rejected: ${notes ?? ""}`.trim());
    });
    run();
    const resolved = this.get(id);
    this.bus?.publish({ type: "approval", data: { id, task_id: resolved.task_id, status: resolved.status } });
    return resolved;
  }

  pending(): Approval[] {
    return this.db.prepare("SELECT * FROM approvals WHERE status = 'pending' ORDER BY id").all() as Approval[];
  }

  /** Pending approvals whose next reminder (at 1x, 2x, ... REMINDER_MINUTES after the request) is due. */
  dueReminders(now = new Date()): Approval[] {
    const minutes = this.policy.reminderMinutes;
    return this.pending().filter(
      (a) => a.reminders_sent < this.policy.reminderCount && now.getTime() >= Date.parse(a.created_at) + (a.reminders_sent + 1) * minutes * 60_000,
    );
  }

  /**
   * Sends every due reminder through `notify` and counts it. After REMINDER_COUNT reminders the
   * approval simply stays pending: the task keeps waiting and nothing else happens.
   */
  async sendDueReminders(notify: (a: Approval, n: number) => Promise<void> | void, now = new Date()): Promise<number> {
    let sent = 0;
    for (const a of this.dueReminders(now)) {
      await notify(a, a.reminders_sent + 1);
      this.db.prepare("UPDATE approvals SET reminders_sent = reminders_sent + 1 WHERE id = ?").run(a.id);
      sent++;
    }
    return sent;
  }
}
