import type { EventBus } from "../api/events.js";
import type { TaskService } from "./tasks.js";

export const WARN_RATIO = 0.8;

export type BudgetState = "ok" | "warn" | "stop";

/**
 * Per-task token cap: one warning at 80%, stop at 100%. The cap is checked between agent calls,
 * so a single long call can overshoot it before the stop takes effect.
 */
export class BudgetService {
  constructor(private tasks: TaskService, private cap: number, private bus?: EventBus) {}

  /** Returns the state and applies it: the warning is raised once, the stop moves the task to `stopped`. */
  enforce(taskId: number): BudgetState {
    const task = this.tasks.get(taskId);
    if (task.tokens_used >= this.cap) {
      if (task.status !== "stopped" && task.status !== "merged") this.tasks.transition(taskId, "stopped", `token cap reached (${task.tokens_used}/${this.cap})`);
      return "stop";
    }
    if (task.tokens_used >= this.cap * WARN_RATIO) {
      if (!this.tasks.hasNote(taskId, "budget_warning")) {
        this.tasks.note(taskId, "budget_warning", `80% of token cap used (${task.tokens_used}/${this.cap})`);
        this.bus?.publish({ type: "budget", data: { task_id: taskId, percent: 80 } });
      }
      return "warn";
    }
    return "ok";
  }
}
