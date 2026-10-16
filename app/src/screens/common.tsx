import type { ReactNode } from "react";
import { ApiError } from "../lib/api";
import { clockTime, relativeTime, scheduleLabel, taskTitle, waitsForQuota, type TaskRow } from "../lib/format";
import type { Loaded } from "../hooks";
import { AiBadge, Skeleton, StatusPill } from "../ui";

export function State<T>({ q, children, skeletons = 2 }: { q: Loaded<T>; children: (data: T) => ReactNode; skeletons?: number }) {
  if (q.data !== null) return <>{children(q.data)}</>;
  if (q.loading) return <Skeleton count={skeletons} />;
  if (q.error instanceof ApiError && q.error.status === 501) return <div className="card"><p className="muted">התכונה הזאת עדיין לא מחוברת בליבה.</p></div>;
  return (
    <div className="card">
      <p>לא הצלחתי לטעון את הנתונים.</p>
      <button type="button" className="btn" onClick={q.reload}>נסה שוב</button>
    </div>
  );
}

/** Errors whose message the core wrote for the owner (in Hebrew): upload rules, computer-only actions, project checks. */
const FRIENDLY = new Set(["media", "local_only", "local_unavailable", "invalid_project", "not_found", "merge_failed", "busy", "operator_failed", "transcribe_failed"]);

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

/** The core's own Hebrew message when it sent one (for example why a merge failed). */
export function coreMessage(err: unknown): string | null {
  if (err instanceof ApiError) {
    const body = err.body as { message?: string } | null;
    if (body?.message) return body.message;
  }
  return null;
}

/** What a task card says under the title: why it stopped, or that it needs the owner. */
export function taskReason(t: TaskRow): string | null {
  if (t.status === "blocked") return t.reason ?? "הסוכן לא הצליח להמשיך.";
  if (t.status === "awaiting_approval") return "הסוכן סיים, צריך את האישור שלך";
  if (t.status === "stopped") return t.reason;
  if (waitsForQuota(t)) return `המכסה של המנוי נגמרה. תמשיך לבד אחרי ${clockTime(t.scheduled_for!)}`;
  if (t.status === "received" && t.scheduled_for) return `מתוזמנת: תתחיל ${scheduleLabel(t.scheduled_for)}`;
  return null;
}

/** One task in a list. The whole card is the tap target. */
export function TaskCard({ t, now, queue }: { t: TaskRow; now: number; queue?: number }) {
  const reason = taskReason(t);
  return (
    <a className="card" href={`#/tasks/${t.id}`}>
      <div className="row between">
        <StatusPill status={t.status} reverted={!!t.reverted_at} paused={waitsForQuota(t)} />
        <span className="muted">{queue ? `מקום ${queue} בתור · ` : ""}{relativeTime(t.updated_at, now)}</span>
      </div>
      <div className="ttl clamp2">{taskTitle(t)}</div>
      {reason && <div className="reason clamp2">{reason}</div>}
      <div className="row wrap"><AiBadge model={t.ai} /><span className="muted"><bdi>{t.project_name}</bdi> · <span className="mono">#{t.id}</span></span></div>
    </a>
  );
}
