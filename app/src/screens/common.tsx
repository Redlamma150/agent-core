import type { ReactNode } from "react";
import { ApiError } from "../lib/api";
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

export function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 409) return "הפעולה כבר לא רלוונטית (המצב השתנה).";
    if (err.status === 404) return "הפריט לא נמצא.";
    if (err.status === 400) return "הקלט לא תקין.";
    if (err.status === 501) return "התכונה הזאת עדיין לא מחוברת בליבה.";
  }
  return "משהו השתבש. נסה שוב.";
}
