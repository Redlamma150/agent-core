import { describe, expect, it } from "vitest";
import { nextNight, Scheduler } from "../src/core/scheduler.js";
import { TaskService } from "../src/core/tasks.js";
import { openDb } from "../src/db/index.js";

describe("nextNight", () => {
  it("is later today when the hour has not come, otherwise tomorrow", () => {
    expect(nextNight(new Date(2026, 9, 16, 22, 30), 2)).toEqual(new Date(2026, 9, 17, 2, 0)); // evening: tomorrow 02:00
    expect(nextNight(new Date(2026, 9, 16, 1, 15), 2)).toEqual(new Date(2026, 9, 16, 2, 0)); // after midnight: today 02:00
    expect(nextNight(new Date(2026, 9, 16, 2, 0), 2)).toEqual(new Date(2026, 9, 17, 2, 0)); // exactly on the hour counts as passed
    expect(nextNight(new Date(2026, 9, 31, 23, 0), 1)).toEqual(new Date(2026, 10, 1, 1, 0)); // month end
  });
});

describe("Scheduler", () => {
  function setup() {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO projects (name, repo_path) VALUES ('p', '/r')").run();
    const tasks = new TaskService(db);
    const started: number[] = [];
    const driver = { start: (id: number) => void started.push(id) } as never;
    return { db, tasks, started, scheduler: new Scheduler(db, tasks, driver) };
  }
  const at = (h: number) => new Date(Date.UTC(2026, 9, 17, h, 0));

  it("holds a scheduled task back from restarts, and starts it when its time has come", () => {
    const t = setup();
    const night = t.tasks.create(1, "tonight", false, at(2));
    const now = t.tasks.create(1, "now");
    expect(t.tasks.get(night.id).scheduled_for).toBe("2026-10-17 02:00:00");
    expect(t.tasks.resumable().map((x) => x.id)).toEqual([now.id]); // the scheduled one is not picked up on a restart

    expect(t.scheduler.runDue(at(1))).toBe(0);
    expect(t.started).toEqual([]);

    expect(t.scheduler.runDue(at(2))).toBe(1);
    expect(t.started).toEqual([night.id]);
    expect(t.tasks.get(night.id).scheduled_for).toBeNull();
    expect(t.scheduler.runDue(at(3))).toBe(0); // only once
    expect(t.tasks.resumable().map((x) => x.id)).toEqual([night.id, now.id]);
  });

  it("skips scheduled tasks that were stopped or deleted meanwhile", () => {
    const t = setup();
    const stopped = t.tasks.create(1, "stopped", false, at(2));
    t.tasks.stop(stopped.id);
    const trashed = t.tasks.create(1, "trashed", false, at(2));
    t.tasks.stop(trashed.id);
    t.tasks.trash(trashed.id);
    expect(t.scheduler.runDue(at(5))).toBe(0);
    expect(t.started).toEqual([]);
  });

  it("starts the earliest first when several are due", () => {
    const t = setup();
    const late = t.tasks.create(1, "late", false, at(4));
    const early = t.tasks.create(1, "early", false, at(2));
    t.scheduler.runDue(at(6));
    expect(t.started).toEqual([early.id, late.id]);
  });
});
