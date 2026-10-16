import type { Db } from "../db/index.js";
import { CHEAP_MODEL, type SettingsService } from "./settings.js";

export type InsightId = "planner_cheaper" | "auto_stash";
export const INSIGHT_IDS: readonly InsightId[] = ["planner_cheaper", "auto_stash"];

export interface Insight {
  id: InsightId;
  title: string;
  body: string;
  /** What the owner gains, stated from measured numbers only. */
  gain: string;
  applied: boolean;
}

export class UnknownInsightError extends Error {}

const WINDOW_DAYS = 7;
const MIN_PLANNER_CALLS = 5;
const MIN_PLANNER_SHARE = 0.2;
const MIN_VALID_RATE = 0.95;
const STASH_DAYS = 14;
const MIN_DIRTY_FAILURES = 2;

const fmt = (n: number) => n.toLocaleString("he-IL");

/**
 * Efficiency suggestions computed from what the system actually ran. A suggestion shows up only when the numbers
 * support it (or when it is already applied, so it can be turned off), and applying one changes a real setting.
 */
export class InsightService {
  constructor(private db: Db, private settings: SettingsService) {}

  list(): Insight[] {
    return [this.plannerCheaper(), this.autoStash()].filter((i): i is Insight => i !== null);
  }

  apply(id: string): void {
    this.change(id, true);
  }

  unapply(id: string): void {
    this.change(id, false);
  }

  private change(id: string, on: boolean): void {
    if (id === "planner_cheaper") this.settings.setRoleModel("planner", on ? CHEAP_MODEL : null);
    else if (id === "auto_stash") this.settings.setAutoStash(on);
    else throw new UnknownInsightError(`unknown insight ${id}`);
  }

  private plannerCheaper(): Insight | null {
    const applied = this.settings.roleModel("planner") === CHEAP_MODEL;
    const since = `-${WINDOW_DAYS} days`;
    const planner = this.db.prepare(
      `SELECT COUNT(*) AS calls, COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens, COALESCE(SUM(valid_output), 0) AS valid, COALESCE(SUM(escalated), 0) AS escalated
       FROM llm_calls WHERE agent = 'planner' AND created_at >= datetime('now', ?)`,
    ).get(since) as { calls: number; tokens: number; valid: number; escalated: number };
    const all = (this.db.prepare("SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens FROM llm_calls WHERE created_at >= datetime('now', ?)").get(since) as { tokens: number }).tokens;
    const share = all > 0 ? planner.tokens / all : 0;
    const supported = planner.calls >= MIN_PLANNER_CALLS && planner.valid / planner.calls >= MIN_VALID_RATE && planner.escalated === 0 && share >= MIN_PLANNER_SHARE;
    if (!supported && !applied) return null;
    const pct = Math.round(share * 100);
    return {
      id: "planner_cheaper",
      title: "המתכנן יכול לרוץ על מודל קטן יותר",
      body: `המתכנן רק קורא את הפרויקט ולא משנה כלום. ב-${WINDOW_DAYS} הימים האחרונים הוא צרך ${fmt(planner.tokens)} טוקנים (${pct}% מהצריכה) ב-${planner.calls} קריאות, בלי הסלמות ובלי פלט לא תקין. הצעה: להריץ אותו על Haiku. אם הוא ייכשל פעמיים, המערכת תעלה לבד למודל החזק.`,
      gain: `${pct}% מהצריכה ירוצו על מודל קטן`,
      applied,
    };
  }

  private autoStash(): Insight | null {
    const applied = this.settings.autoStash();
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM steps WHERE status = 'merge_failed_dirty' AND created_at >= datetime('now', ?)").get(`-${STASH_DAYS} days`) as { n: number };
    if (row.n < MIN_DIRTY_FAILURES && !applied) return null;
    return {
      id: "auto_stash",
      title: "אותה חסימה חזרה: שינויים שלא נשמרו",
      body: `המיזוג נעצר ${row.n} פעמים ב-${STASH_DAYS} הימים האחרונים כי בפרויקט היו שינויים שלא נשמרו. הצעה: לשמור אותם בצד אוטומטית לפני כל מיזוג ולהחזיר אותם אחריו. אם הם מתנגשים עם המשימה הם נשארים ב-git stash ואתה מקבל הודעה.`,
      gain: "פחות עצירות במיזוג",
      applied,
    };
  }
}
