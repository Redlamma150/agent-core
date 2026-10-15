import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EventBus } from "../src/api/events.js";
import { AlreadyResolvedError, ApprovalService } from "../src/core/approvals.js";
import { InvalidTransitionError, NotFoundError, TASK_STATUSES, TaskService, type TaskStatus } from "../src/core/tasks.js";
import { openDb, type Db } from "../src/db/index.js";

const ALLOWED: Record<TaskStatus, TaskStatus[]> = {
  received: ["planning", "blocked", "stopped"],
  planning: ["in_progress", "awaiting_approval", "blocked", "stopped"],
  in_progress: ["awaiting_approval", "blocked", "stopped"],
  awaiting_approval: ["in_progress", "merged", "blocked", "stopped"],
  blocked: ["planning", "in_progress", "stopped"],
  merged: [],
  stopped: ["planning", "in_progress"],
};

/** Shortest legal path from `received` to each state, used to reach any starting state. */
const PATH_TO: Record<TaskStatus, TaskStatus[]> = {
  received: [],
  planning: ["planning"],
  in_progress: ["planning", "in_progress"],
  awaiting_approval: ["planning", "awaiting_approval"],
  blocked: ["blocked"],
  merged: ["planning", "awaiting_approval", "merged"],
  stopped: ["stopped"],
};

function setup(db: Db = openDb(":memory:"), bus?: EventBus) {
  db.prepare("INSERT OR IGNORE INTO projects (id, name, repo_path) VALUES (1, 'p', '/r')").run();
  const tasks = new TaskService(db, bus);
  const approvals = new ApprovalService(db, tasks, { reminderMinutes: 10, reminderCount: 2 }, bus);
  return { db, tasks, approvals };
}

function taskIn(tasks: TaskService, status: TaskStatus) {
  const t = tasks.create(1, "work");
  for (const step of PATH_TO[status]) tasks.transition(t.id, step);
  return t.id;
}

describe("task state machine", () => {
  for (const from of TASK_STATUSES) {
    for (const to of TASK_STATUSES) {
      const legal = ALLOWED[from].includes(to);
      it(`${from} -> ${to} is ${legal ? "allowed" : "rejected"}`, () => {
        const { tasks } = setup();
        const id = taskIn(tasks, from);
        if (legal) {
          expect(tasks.transition(id, to).status).toBe(to);
        } else {
          expect(() => tasks.transition(id, to)).toThrow(InvalidTransitionError);
          expect(tasks.get(id).status).toBe(from); // unchanged
        }
      });
    }
  }

  it("records every transition in steps", () => {
    const { db, tasks } = setup();
    const id = taskIn(tasks, "in_progress");
    const rows = db.prepare("SELECT from_status, to_status FROM steps WHERE task_id = ? ORDER BY id").all(id);
    expect(rows).toEqual([
      { from_status: null, to_status: "received" },
      { from_status: "received", to_status: "planning" },
      { from_status: "planning", to_status: "in_progress" },
    ]);
  });

  it("does not write a step for a rejected transition", () => {
    const { db, tasks } = setup();
    const id = taskIn(tasks, "merged");
    const before = (db.prepare("SELECT COUNT(*) AS n FROM steps").get() as { n: number }).n;
    expect(() => tasks.transition(id, "in_progress")).toThrow();
    expect((db.prepare("SELECT COUNT(*) AS n FROM steps").get() as { n: number }).n).toBe(before);
  });

  it("stop works immediately from every non-terminal state", () => {
    for (const s of ["received", "planning", "in_progress", "awaiting_approval", "blocked"] as const) {
      const { tasks } = setup();
      expect(tasks.stop(taskIn(tasks, s)).status).toBe("stopped");
    }
  });

  it("throws NotFoundError for an unknown task", () => {
    expect(() => setup().tasks.get(99)).toThrow(NotFoundError);
  });

  it("publishes an event per transition", () => {
    const bus = new EventBus();
    const seen: unknown[] = [];
    bus.subscribe((e) => seen.push(e));
    const { tasks } = setup(openDb(":memory:"), bus);
    const t = tasks.create(1, "x");
    tasks.transition(t.id, "planning");
    expect(seen).toEqual([
      { type: "task", data: { id: t.id, status: "received" } },
      { type: "task", data: { id: t.id, status: "planning" } },
    ]);
  });
});

describe("restart in the middle of a task", () => {
  it("continues from the saved state, including a pending approval", () => {
    const dir = mkdtempSync(join(tmpdir(), "core-"));
    const path = join(dir, "core.db");
    try {
      let s = setup(openDb(path));
      const working = taskIn(s.tasks, "in_progress");
      const waiting = taskIn(s.tasks, "planning");
      const approval = s.approvals.request(waiting, "merge it?", new Date("2026-01-01T10:00:00Z"));
      s.db.close();

      s = setup(openDb(path)); // "restart"
      expect(s.tasks.get(working).status).toBe("in_progress");
      expect(s.tasks.resumable().map((t) => t.id)).toEqual([working]);
      expect(s.tasks.get(waiting).status).toBe("awaiting_approval");
      expect(s.approvals.pending().map((a) => a.id)).toEqual([approval.id]);

      s.approvals.resolve(approval.id, true);
      expect(s.tasks.get(waiting).status).toBe("merged");
      s.tasks.transition(working, "awaiting_approval");
      s.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("approvals", () => {
  it("request parks the task, approve merges it", () => {
    const { tasks, approvals } = setup();
    const id = taskIn(tasks, "in_progress");
    const a = approvals.request(id, "ok to merge?");
    expect(tasks.get(id).status).toBe("awaiting_approval");
    expect(a.status).toBe("pending");
    expect(approvals.resolve(a.id, true).status).toBe("approved");
    expect(tasks.get(id).status).toBe("merged");
  });

  it("reject returns the task to in_progress and keeps the note", () => {
    const { tasks, approvals } = setup();
    const id = taskIn(tasks, "in_progress");
    const a = approvals.request(id, "ok?");
    const r = approvals.resolve(a.id, false, "fix the tests");
    expect(r).toMatchObject({ status: "rejected", notes: "fix the tests" });
    expect(tasks.get(id).status).toBe("in_progress");
  });

  it("cannot be resolved twice", () => {
    const { tasks, approvals } = setup();
    const a = approvals.request(taskIn(tasks, "in_progress"), "ok?");
    approvals.resolve(a.id, true);
    expect(() => approvals.resolve(a.id, false)).toThrow(AlreadyResolvedError);
  });

  it("cannot request approval for a finished task, and leaves no orphan approval", () => {
    const { db, tasks, approvals } = setup();
    const id = taskIn(tasks, "stopped");
    expect(() => approvals.request(id, "?")).toThrow(InvalidTransitionError);
    expect((db.prepare("SELECT COUNT(*) AS n FROM approvals").get() as { n: number }).n).toBe(0);
  });

  it("stopping a task with a pending approval leaves the approval pending but the task stopped", () => {
    const { tasks, approvals } = setup();
    const id = taskIn(tasks, "in_progress");
    approvals.request(id, "?");
    expect(tasks.stop(id).status).toBe("stopped");
  });
});

describe("reminders", () => {
  const t0 = new Date("2026-01-01T10:00:00Z");
  const at = (min: number) => new Date(t0.getTime() + min * 60_000);

  it("sends one at 10 minutes, one at 20, then stops and the task keeps waiting", async () => {
    const { tasks, approvals } = setup();
    const id = taskIn(tasks, "in_progress");
    const a = approvals.request(id, "?", t0);
    const sent: number[] = [];
    const notify = (_a: unknown, n: number) => void sent.push(n);

    expect(await approvals.sendDueReminders(notify, at(9))).toBe(0);
    expect(await approvals.sendDueReminders(notify, at(10))).toBe(1);
    expect(await approvals.sendDueReminders(notify, at(15))).toBe(0);
    expect(await approvals.sendDueReminders(notify, at(20))).toBe(1);
    expect(await approvals.sendDueReminders(notify, at(300))).toBe(0);

    expect(sent).toEqual([1, 2]);
    expect(approvals.get(a.id)).toMatchObject({ status: "pending", reminders_sent: 2 });
    expect(tasks.get(id).status).toBe("awaiting_approval");
  });

  it("does not remind about a resolved approval", async () => {
    const { tasks, approvals } = setup();
    const a = approvals.request(taskIn(tasks, "in_progress"), "?", t0);
    approvals.resolve(a.id, true);
    expect(await approvals.sendDueReminders(() => {}, at(60))).toBe(0);
  });

  it("does not count a reminder whose delivery failed", async () => {
    const { tasks, approvals } = setup();
    const a = approvals.request(taskIn(tasks, "in_progress"), "?", t0);
    await expect(approvals.sendDueReminders(() => { throw new Error("push down"); }, at(10))).rejects.toThrow("push down");
    expect(approvals.get(a.id).reminders_sent).toBe(0);
  });
});
