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
