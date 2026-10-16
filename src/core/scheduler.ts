import type { Db } from "../db/index.js";
import type { TaskDriver } from "./pipeline.js";
import { sqliteTime, type TaskService } from "./tasks.js";

/** The next time the clock shows `hour`:00 (today if it has not passed yet, otherwise tomorrow), in the computer's local time. */
export function nextNight(now: Date, hour: number): Date {
  const at = new Date(now);
  at.setHours(hour, 0, 0, 0);
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
  return at;
}

/** Starts tasks the owner scheduled ("tonight") once their time has come. Runs on a timer; a restart loses nothing. */
export class Scheduler {
  constructor(private db: Db, private tasks: TaskService, private driver: TaskDriver) {}

  /** Starts every scheduled task that is due and returns how many were started. */
  runDue(now = new Date()): number {
    const due = this.db
      .prepare("SELECT id FROM tasks WHERE status = 'received' AND scheduled_for IS NOT NULL AND scheduled_for <= ? AND deleted_at IS NULL ORDER BY scheduled_for, id")
      .all(sqliteTime(now)) as { id: number }[];
    for (const { id } of due) {
      this.tasks.clearSchedule(id);
      this.driver.start(id);
    }
    return due.length;
  }
}
