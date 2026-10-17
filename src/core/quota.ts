import type { Db } from "../db/index.js";
import type { SettingsService } from "./settings.js";

/** What the Claude Code runtime reports about the subscription's usage windows. Only the fields the core reads. */
export interface RateLimitInfo {
  status?: string;
  /** Unix seconds. */
  resetsAt?: number;
  rateLimitType?: string;
  /** 0 to 1. */
  utilization?: number;
  /** Not in the SDK's type, but sent at runtime: both windows at once. */
  unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number } | undefined>;
}

export type WindowKind = "five_hour" | "seven_day";
const KINDS: readonly WindowKind[] = ["five_hour", "seven_day"];

export interface QuotaWindow {
  /** Share of the window used, 0 to 100. */
  percent: number;
  resets_at: string;
}
export interface QuotaSnapshot {
  five_hour: QuotaWindow | null;
  seven_day: QuotaWindow | null;
  /** Set while the subscription refused a request: nothing should run until then. */
  blocked_until: string | null;
}

/** Margin after a reset before work resumes, so the first call does not land a second too early. */
export const RESUME_MARGIN_MS = 60_000;
/** When the runtime reports a refusal without saying when the window resets. */
export const UNKNOWN_RESET_MS = 15 * 60_000;

const toDate = (n: number) => new Date(n < 1e11 ? n * 1000 : n); // the runtime sends seconds; be tolerant of milliseconds
const sqlite = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");
const fromSqlite = (s: string) => new Date(s.replace(" ", "T") + "Z");
const percentOf = (u: number) => Math.round((u <= 1 ? u * 100 : u) * 10) / 10;

/**
 * The subscription's real usage windows (5 hours and 7 days), learned from the runtime's own reports during agent runs,
 * and the "out of quota until" marker that makes tasks wait instead of failing. Nothing here calls any service.
 */
export class QuotaService {
  constructor(private db: Db, private settings: SettingsService) {}

  /** Stores what a rate limit report says. Returns the reset time when the report is a refusal. */
  record(info: RateLimitInfo, now = new Date()): Date | null {
    const reports: [WindowKind, number, number | undefined][] = [];
    for (const kind of KINDS) {
      const w = info.unifiedWindows?.[kind];
      if (w?.utilization !== undefined && w.resetsAt !== undefined) reports.push([kind, w.utilization, w.resetsAt]);
    }
    if (reports.length === 0 && info.rateLimitType && (KINDS as readonly string[]).includes(info.rateLimitType) && info.utilization !== undefined && info.resetsAt !== undefined) {
      reports.push([info.rateLimitType as WindowKind, info.utilization, info.resetsAt]);
    }
    const save = this.db.prepare("INSERT INTO quota_windows (kind, percent, resets_at) VALUES (?, ?, ?) ON CONFLICT(kind) DO UPDATE SET percent = excluded.percent, resets_at = excluded.resets_at, updated_at = datetime('now')");
    for (const [kind, utilization, resetsAt] of reports) save.run(kind, percentOf(utilization), sqlite(toDate(resetsAt!)));

    if (info.status !== "rejected") return null;
    const own = info.rateLimitType ? info.unifiedWindows?.[info.rateLimitType]?.resetsAt : undefined;
    const reset = info.resetsAt ?? own;
    const until = reset !== undefined ? toDate(reset) : new Date(now.getTime() + UNKNOWN_RESET_MS);
    this.block(until);
    return until;
  }

  /** Nothing should run before `until`. */
  block(until: Date): void {
    this.settings.set("quota.blocked_until", sqlite(until));
  }

  clearBlock(): void {
    this.settings.set("quota.blocked_until", null);
  }

  /** The moment the subscription is expected to accept work again, or null when it is not blocked. */
  blockedUntil(now = new Date()): Date | null {
    const raw = this.settings.get("quota.blocked_until");
    if (!raw) return null;
    const until = fromSqlite(raw);
    return until.getTime() > now.getTime() ? until : null;
  }

  /** Wait for the quota to come back (true, the default) or block the task and let the owner continue it. */
  autoResume(): boolean {
    return this.settings.get("quota.auto_resume") !== "false";
  }
  setAutoResume(on: boolean): void {
    this.settings.set("quota.auto_resume", on ? null : "false");
  }

  snapshot(now = new Date()): QuotaSnapshot {
    const rows = this.db.prepare("SELECT kind, percent, resets_at FROM quota_windows").all() as { kind: WindowKind; percent: number; resets_at: string }[];
    const out: QuotaSnapshot = { five_hour: null, seven_day: null, blocked_until: this.blockedUntil(now)?.toISOString() ?? null };
    for (const r of rows) {
      const reset = fromSqlite(r.resets_at);
      // A window that already reset says nothing about the new one: unknown until the next report.
      if (reset.getTime() > now.getTime()) out[r.kind] = { percent: r.percent, resets_at: reset.toISOString() };
    }
    return out;
  }

  /** When the 5 hour window resets, if it is known and still ahead. */
  nextReset(now = new Date()): Date | null {
    const w = this.snapshot(now).five_hour;
    return w ? new Date(w.resets_at) : null;
  }
}
