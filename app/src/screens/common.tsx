import type { ReactNode } from "react";
import { ApiError } from "../lib/api";
import { relativeTime, statusLabel, taskTitle, type TaskRow } from "../lib/format";
import type { Loaded } from "../hooks";

export function State<T>({ q, children }: { q: Loaded<T>; children: (data: T) => ReactNode }) {
  if (q.data !== null) return <>{children(q.data)}</>;
  if (q.loading) return <p className="muted">טוען…</p>;
  if (q.error instanceof ApiError && q.error.status === 501) return <p className="muted">התכונה הזאת עדיין לא מחוברת בליבה.</p>;
  return (
    <div className="card">
      <p>לא הצלחתי לטעון את הנתונים.</p>
      <button onClick={q.reload}>נסה שוב</button>
    </div>
  );
}

/** Errors whose message the core wrote for the owner (in Hebrew): upload rules, computer-only actions, project checks. */
const FRIENDLY = new Set(["media", "local_only", "local_unavailable", "invalid_project", "not_found"]);

export function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    const body = err.body as { error?: string; message?: string } | null;
    if (body?.error && FRIENDLY.has(body.error) && body.message) return body.message;
    if (err.status === 409) return "הפעולה כבר לא רלוונטית (המצב השתנה).";
    if (err.status === 404) return "הפריט לא נמצא.";
    if (err.status === 400) return "הקלט לא תקין.";
    if (err.status === 501) return "התכונה הזאת עדיין לא מחוברת בליבה.";
  }
  return "משהו השתבש. נסה שוב.";
}


export function StatusChip({ status }: { status: string }) {
  return <span className={`status s-${status}`}>{statusLabel(status)}</span>;
}

/** One task in a list: title first, then where it stands and, when it stopped, why. */
export function TaskCard({ t, now, queue }: { t: TaskRow; now: number; queue?: number }) {
  const attention = t.status === "awaiting_approval" ? "needs" : t.status === "blocked" ? "blocked" : "";
  return (
    <a className={`card task ${attention}`} href={`#/tasks/${t.id}`}>
      <div className="row between">
        <span className="pill">{t.project_name}</span>
        <StatusChip status={t.status} />
      </div>
      <span className="title">{taskTitle(t)}</span>
      {t.status === "blocked" && t.reason && <span className="reason">{t.reason}</span>}
      {t.status === "awaiting_approval" && <span className="reason">הסוכן סיים. צריך את האישור שלך.</span>}
      <span className="muted small">
        {queue ? `בתור, מקום ${queue} · ` : ""}
        {relativeTime(t.updated_at, now)}
      </span>
    </a>
  );
}
