import type { BudgetService } from "../core/budget.js";
import type { SettingsService } from "../core/settings.js";
import type { TaskService } from "../core/tasks.js";
import type { Handoff } from "./contract.js";
import { MIN_CONFIDENCE, route } from "./router.js";
import type { AgentRunner, RunRequest } from "./runner.js";

export type Outcome =
  | { kind: "completed"; handoff: Handoff }
  | { kind: "blocked"; reasons: string[]; handoff?: Handoff }
  | { kind: "stopped"; reason: string };

/** Safety net: every loop iteration either returns, adds a failure or uses an escalation, so this is never reached in practice. */
const MAX_ATTEMPTS = 12;

/** The agent's own first sentence, short enough for a notification. The planner and builder write their summaries in Hebrew. */
export function shortReason(summary: string, max = 90): string {
  const first = (summary.split(/\n|(?<=[.!?])\s/)[0] ?? "").trim();
  return first.length > max ? `${first.slice(0, max - 1).trimEnd()}…` : first;
}

/**
 * Runs an agent for a task with routing, failure counting, escalation and the token cap.
 * Escalations and budget warnings are written to the task's step log.
 */
export async function executeAgent(
  deps: { tasks: TaskService; runner: AgentRunner; budget: BudgetService; settings?: SettingsService },
  req: Omit<RunRequest, "model" | "escalated" | "taskId"> & { taskId: number },
): Promise<Outcome> {
  const { tasks, runner, budget, settings } = deps;
  const id = req.taskId;
  let lastConfidence: number | undefined;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (budget.enforce(id) === "stop") return { kind: "stopped", reason: "token cap reached" };
    const task = tasks.get(id);
    if (task.status === "stopped") return { kind: "stopped", reason: "stopped by owner" };
    if (task.status === "blocked") return { kind: "blocked", reasons: ["blocked while running (time limit)"] };

    const decision = route({ role: req.role, consecutiveFailures: task.failures, escalations: task.escalations, flagged: task.flagged === 1, lastConfidence, modelOverride: settings?.roleModel(req.role) });
    if (decision.action === "block") {
      tasks.transition(id, "blocked", decision.reasons.join("; "), "הסוכן נכשל או לא היה בטוח בעצמו, גם אחרי הסלמה למודל החזק");
      return { kind: "blocked", reasons: decision.reasons };
    }
    if (decision.escalate) {
      const n = tasks.recordEscalation(id);
      tasks.note(id, "escalation", `escalated to ${decision.model} (escalation ${n}): ${decision.reasons.join("; ")}`);
      lastConfidence = undefined;
    }

    const res = await runner.run({ ...req, model: decision.model, escalated: decision.escalate });
    if (budget.enforce(id) === "stop") return { kind: "stopped", reason: "token cap reached" };
    const after = tasks.get(id).status;
    if (after === "stopped") return { kind: "stopped", reason: "stopped by owner" };
    if (after === "blocked") return { kind: "blocked", reasons: ["blocked while running (time limit)"] };

    if (!res.ok || res.handoff.status === "failed") {
      tasks.note(id, "agent_error", res.ok ? `${req.role} reported failure: ${res.handoff.summary}` : `${req.role}: ${res.reason}`);
      tasks.recordFailure(id);
      continue;
    }
    tasks.resetFailures(id);
    if (res.handoff.status === "blocked") {
      tasks.transition(id, "blocked", res.handoff.summary, `הסוכן דיווח שהוא תקוע: ${shortReason(res.handoff.summary)}`);
      return { kind: "blocked", reasons: [res.handoff.summary], handoff: res.handoff };
    }
    if (res.handoff.confidence < MIN_CONFIDENCE) {
      lastConfidence = res.handoff.confidence;
      continue;
    }
    return { kind: "completed", handoff: res.handoff };
  }
  tasks.transition(id, "blocked", `gave up after ${MAX_ATTEMPTS} attempts`, "הסוכן לא הצליח להתקדם אחרי כמה ניסיונות");
  return { kind: "blocked", reasons: [`gave up after ${MAX_ATTEMPTS} attempts`] };
}
