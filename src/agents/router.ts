import type { AgentRole } from "./contract.js";

/**
 * Routing table: every role runs on Sonnet by default, Opus is the escalation model.
 * Aliases are resolved to the newest model by the Claude Code runtime.
 */
export const DEFAULT_MODEL = "sonnet";
export const ESCALATION_MODEL = "opus";
export const MODEL_BY_ROLE: Record<AgentRole, string> = {
  planner: DEFAULT_MODEL,
  builder: DEFAULT_MODEL,
  tester: DEFAULT_MODEL,
  red_team: DEFAULT_MODEL,
  operator: DEFAULT_MODEL,
};

export const MAX_ESCALATIONS = 2;
export const FAILURES_BEFORE_ESCALATION = 2;
export const MIN_CONFIDENCE = 0.6;

export interface RouteInput {
  role: AgentRole;
  /** Consecutive failures since the last success or escalation. */
  consecutiveFailures: number;
  /** Escalations already used by this task. */
  escalations: number;
  /** Task was marked complex or security-sensitive. */
  flagged: boolean;
  /** Confidence reported by the previous valid result, if any. */
  lastConfidence?: number;
  /** A model the owner routed this role to (an applied suggestion). Escalation still goes to the strong model. */
  modelOverride?: string;
}

export type Route =
  | { action: "run"; model: string; escalate: boolean; reasons: string[] }
  | { action: "block"; reasons: string[] };

/** Escalation triggers that currently apply. A flagged task is escalated once, then judged by the other triggers. */
export function escalationReasons(i: RouteInput): string[] {
  const reasons: string[] = [];
  if (i.consecutiveFailures >= FAILURES_BEFORE_ESCALATION) reasons.push(`${i.consecutiveFailures} consecutive failures`);
  if (i.flagged && i.escalations === 0) reasons.push("task flagged complex or security-sensitive");
  if (i.lastConfidence !== undefined && i.lastConfidence < MIN_CONFIDENCE) reasons.push(`confidence ${i.lastConfidence} below ${MIN_CONFIDENCE}`);
  return reasons;
}

export function route(i: RouteInput): Route {
  const reasons = escalationReasons(i);
  if (reasons.length === 0) {
    return { action: "run", model: i.escalations > 0 ? ESCALATION_MODEL : (i.modelOverride ?? MODEL_BY_ROLE[i.role]), escalate: false, reasons };
  }
  if (i.escalations >= MAX_ESCALATIONS) {
    return { action: "block", reasons: [...reasons, `escalation limit (${MAX_ESCALATIONS}) reached`] };
  }
  return { action: "run", model: ESCALATION_MODEL, escalate: true, reasons };
}
