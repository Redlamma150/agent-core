export const STATUS_LABELS: Record<string, string> = {
  received: "התקבלה",
  planning: "בתכנון",
  in_progress: "בביצוע",
  awaiting_approval: "ממתינה לאישור",
  merged: "מוזגה",
  blocked: "חסומה",
  stopped: "עצורה",
};

export const statusLabel = (s: string) => STATUS_LABELS[s] ?? s;

/** SQLite stores UTC as "YYYY-MM-DD HH:MM:SS"; approvals store ISO strings. Both parse here. */
export function parseDbDate(value: string): Date {
  return new Date(/[zZ]|[+-]\d\d:\d\d$/.test(value) ? value : value.replace(" ", "T") + "Z");
}

export function formatDate(value: string, locale = "he-IL"): string {
  const d = parseDbDate(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString(locale, { dateStyle: "short", timeStyle: "short" });
}

export const formatNumber = (n: number) => n.toLocaleString("he-IL");

export interface TaskRow {
  id: number;
  project_id: number;
  project_name: string;
  title: string | null;
  description: string;
  status: string;
  branch: string | null;
  tokens_used: number;
  flagged: number;
  reason: string | null;
  archived_at: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export const taskTitle = (t: Pick<TaskRow, "title" | "description">) => t.title || t.description.split("\n")[0] || "ללא כותרת";

/** The three groups on the home screen. */
export const GROUPS = {
  needs: { label: "דורשות אותי", statuses: ["awaiting_approval", "blocked"] },
  active: { label: "בעבודה", statuses: ["received", "planning", "in_progress"] },
  done: { label: "הסתיימו", statuses: ["merged", "stopped"] },
} as const;
export type GroupKey = keyof typeof GROUPS;
export const RUNNING = new Set<string>(["planning", "in_progress"]);

/** Short Hebrew line for "a moment ago": minutes and hours, then a date. */
export function relativeTime(value: string, now = Date.now()): string {
  const diff = Math.max(0, now - parseDbDate(value).getTime());
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "עכשיו";
  if (min < 60) return `לפני ${min} דק׳`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `לפני ${hours} שע׳`;
  return formatDate(value);
}

/** What the agent is doing, in plain Hebrew, from a recorded tool call. */
export function activityLabel(tool: string): string {
  switch (tool) {
    case "Read": return "קורא";
    case "Edit": return "עורך";
    case "Write": return "כותב";
    case "Glob": return "מחפש קבצים";
    case "Grep": return "מחפש בקוד";
    case "Bash": return "מריץ פקודה";
    case "Tests": return "מריץ את בדיקות הפרויקט";
    default: return tool;
  }
}

export const STAGES = ["תכנון", "בנייה", "אישור", "מוזגה"] as const;

/** Index of the stage a task is in. Blocked and stopped tasks stay at the last stage they reached. */
export function stageOf(status: string, reached: readonly (string | null)[] = []): number {
  switch (status) {
    case "received": case "planning": return 0;
    case "in_progress": return 1;
    case "awaiting_approval": return 2;
    case "merged": return 3;
    default:
      if (reached.includes("awaiting_approval")) return 2;
      if (reached.includes("in_progress")) return 1;
      return 0;
  }
}

const STEP_LABELS: Record<string, string> = {
  received: "המשימה נוצרה",
  planning: "התחיל תכנון",
  in_progress: "התחילה הבנייה",
  awaiting_approval: "ממתינה לאישור שלך",
  merged: "מוזגה",
  blocked: "נחסמה",
  stopped: "נעצרה",
};
const NOTE_LABELS: Record<string, string> = {
  agent_error: "הסוכן נתקל בבעיה",
  escalation: "הועברה למודל חזק יותר",
  budget_warning: "נוצלו 80% מתקרת הטוקנים",
  owner_note: "ההערה שלך",
  edited: "הטקסט נערך",
  tests_passed: "בדיקות הפרויקט עברו",
  tests_failed: "בדיקות הפרויקט נכשלו",
};

export function stepLabel(step: { agent: string; status: string; to_status: string | null }): string {
  if (step.to_status) return STEP_LABELS[step.to_status] ?? step.to_status;
  if (step.agent === "planner") return "התוכנית מוכנה";
  return NOTE_LABELS[step.status] ?? step.status;
}
