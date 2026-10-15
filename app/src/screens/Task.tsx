import { useState, type FormEvent } from "react";
import { useApi, useTick } from "../hooks";
import { api } from "../lib/api";
import { activityLabel, formatDate, formatNumber, RUNNING, relativeTime, STAGES, stageOf, stepLabel, taskTitle, type TaskRow } from "../lib/format";
import { errorText, State, StatusChip } from "./common";

interface ActivityRow { id: number; agent: string; tool: string; target: string | null; created_at: string }
interface StepRow { id: number; agent: string; status: string; from_status: string | null; to_status: string | null; summary: string | null; created_at: string }
interface ApprovalRow { id: number; task_id: number; request_text: string; reminders_sent: number; created_at: string }

export function TaskScreen({ id }: { id: number }) {
  const task = useApi<TaskRow>(`/tasks/${id}`);
  return (
    <>
      <a className="back" href="#/tasks">‹ חזרה למשימות</a>
      <State q={task}>{(t) => <TaskView t={t} reload={task.reload} />}</State>
    </>
  );
}

function TaskView({ t, reload }: { t: TaskRow; reload: () => void }) {
  const steps = useApi<StepRow[]>(`/tasks/${t.id}/steps`);
  const feed = useApi<ActivityRow[]>(`/tasks/${t.id}/activity`);
  const approvals = useApi<ApprovalRow[]>("/approvals");
  const now = useTick();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  /** Runs one action on the task and refreshes; the core answers 409 when the state no longer fits. */
  async function act(path: string, method = "POST", body: unknown = {}) {
    setError(null);
    try {
      const res = await api<{ id: number }>(`/tasks/${t.id}${path}`, { method, body });
      if (path === "/duplicate") window.location.hash = `#/tasks/${res.id}`;
      reload();
      steps.reload();
    } catch (err) {
      setError(errorText(err));
    }
  }

  const approval = approvals.data?.find((a) => a.task_id === t.id);
  const reached = (steps.data ?? []).map((s) => s.to_status);
  const stage = stageOf(t.status, reached);
  const running = RUNNING.has(t.status) || t.status === "received";
  const trashed = t.deleted_at !== null;

  return (
    <>
      <div className="stack">
        <div className="row between wrap">
          <span className="pill">{t.project_name}</span>
          <StatusChip status={t.status} />
        </div>
        <h2>{taskTitle(t)}</h2>
        <ol className="stages" aria-label="שלבי המשימה">
          {STAGES.map((label, i) => {
            const state = i < stage ? "done" : i === stage ? `here ${t.status === "blocked" || t.status === "stopped" ? "bad" : t.status === "awaiting_approval" ? "need" : ""}` : "";
            return <li key={label} className={state} aria-current={i === stage ? "step" : undefined}>{label}</li>;
          })}
        </ol>
      </div>

      {trashed && (
        <div className="callout info">
          <strong>המשימה בפח</strong>
          <span className="small">היא תימחק לצמיתות 30 יום אחרי המחיקה.</span>
          <button onClick={() => act("/restore")}>שחזר</button>
        </div>
      )}

      {!trashed && t.status === "blocked" && <BlockedPanel t={t} act={act} />}
      {!trashed && t.status === "awaiting_approval" && approval && <ApprovalPanel a={approval} onDone={() => { reload(); approvals.reload(); steps.reload(); }} />}
      {!trashed && t.status === "stopped" && (
        <div className="callout info">
          <strong>המשימה נעצרה</strong>
          {t.reason && <span className="small">{t.reason}</span>}
          <ContinueForm onContinue={(note) => act("/continue", "POST", { note })} />
        </div>
      )}

      {running && !trashed && <LiveFeed rows={feed.data ?? []} task={t} now={now} onStop={() => act("/stop")} />}

      {error && <p className="error" role="alert">{error}</p>}

      {editing ? (
        <EditForm t={t} onCancel={() => setEditing(false)} onSave={async (title, description) => { await act("", "PATCH", { title, description }); setEditing(false); }} />
      ) : (
        <div className="card">
          <div className="row between"><h3>מה ביקשתי</h3></div>
          <p className="pre">{t.description}</p>
        </div>
      )}

      {!trashed && !editing && <Actions t={t} act={act} onEdit={() => setEditing(true)} />}

      {!running && feed.data && feed.data.length > 0 && (
        <details className="card">
          <summary>מה הסוכן עשה ({feed.data.length} פעולות)</summary>
          <FeedList rows={feed.data} />
        </details>
      )}

      <details className="card" open={t.status === "blocked" || t.status === "stopped"}>
        <summary>היסטוריה</summary>
        {(steps.data ?? []).length === 0 && <p className="muted small">עדיין אין היסטוריה למשימה הזאת.</p>}
        <ol className="timeline">
          {(steps.data ?? []).map((s) => (
            <li key={s.id} className={s.to_status === "blocked" || s.status === "agent_error" || s.status === "tests_failed" ? "bad" : s.to_status === "merged" || s.status === "tests_passed" ? "good" : s.to_status === "awaiting_approval" ? "need" : ""}>
              <strong>{stepLabel(s)}</strong>
              {s.summary && s.summary !== "task created" && <span className="muted small pre">{s.summary}</span>}
              <span className="muted small">{formatDate(s.created_at)}</span>
            </li>
          ))}
        </ol>
      </details>

      <div className="card">
        <dl>
          <dt>ענף</dt><dd><bdi>{t.branch ?? "—"}</bdi></dd>
          <dt>טוקנים</dt><dd>{formatNumber(t.tokens_used)}</dd>
          <dt>נוצרה</dt><dd>{formatDate(t.created_at)}</dd>
          <dt>עודכנה</dt><dd>{relativeTime(t.updated_at, now)}</dd>
          <dt>מספר</dt><dd>#{t.id}</dd>
        </dl>
      </div>
    </>
  );
}

function FeedList({ rows }: { rows: ActivityRow[] }) {
  return (
    <ul className="feed">
      {[...rows].reverse().map((r) => (
        <li key={r.id}>
          <span>{activityLabel(r.tool)} {r.target && <bdi>{r.target}</bdi>}</span>
          <span className="muted small">{r.agent === "planner" ? "מתכנן" : r.agent === "builder" ? "בונה" : "מערכת"}</span>
        </li>
      ))}
    </ul>
  );
}

function LiveFeed({ rows, task, now, onStop }: { rows: ActivityRow[]; task: TaskRow; now: number; onStop: () => void }) {
  const [sure, setSure] = useState(false);
  return (
    <div className="card now">
      <div className="row between">
        <span className="muted small"><span className="live-dot pulse" />{task.status === "received" ? "בתור, ממתין לתורו" : task.status === "planning" ? "הסוכן מתכנן" : "הסוכן בונה"} · {relativeTime(task.created_at, now)}</span>
        <span className="muted small">{formatNumber(task.tokens_used)} טוקנים</span>
      </div>
      {rows.length === 0 ? <p className="muted">מחכה לפעולה הראשונה…</p> : <FeedList rows={rows} />}
      {sure ? (
        <div className="actions">
          <button className="danger solid" onClick={onStop}>כן, עצור עכשיו</button>
          <button onClick={() => setSure(false)}>ביטול</button>
        </div>
      ) : <button className="danger" onClick={() => setSure(true)}>עצור משימה</button>}
    </div>
  );
}

function ContinueForm({ onContinue }: { onContinue: (note: string) => void }) {
  const [note, setNote] = useState("");
  return (
    <div className="stack">
      <label htmlFor="note">הערה לסוכן (לא חובה)</label>
      <textarea id="note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="למשל: תשתמש בשם הקובץ index.html" />
      <button className="primary" onClick={() => onContinue(note)}>המשך מאותו מקום</button>
    </div>
  );
}

function BlockedPanel({ t, act }: { t: TaskRow; act: (path: string, method?: string, body?: unknown) => Promise<void> }) {
  return (
    <div className="callout bad">
      <strong>המשימה נתקעה</strong>
      <span className="pre">{t.reason ?? "הסוכן לא הצליח להמשיך."}</span>
      <ContinueForm onContinue={(note) => act("/continue", "POST", { note })} />
    </div>
  );
}

function ApprovalPanel({ a, onDone }: { a: ApprovalRow; onDone: () => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function decide(decision: "approve" | "reject") {
    setBusy(true);
    setError(null);
    try {
      await api(`/approvals/${a.id}`, { method: "POST", body: { decision, note: note.trim() || undefined } });
      onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="callout need">
      <strong>מחכה לאישור שלך</strong>
      <p className="pre">{a.request_text}</p>
      <label htmlFor={`n-${a.id}`}>הערה (חובה רק אם דוחים)</label>
      <textarea id={`n-${a.id}`} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
      {error && <p className="error" role="alert">{error}</p>}
      <div className="actions">
        <button className="primary" disabled={busy} onClick={() => decide("approve")}>אשר ומזג</button>
        <button className="danger" disabled={busy || note.trim() === ""} onClick={() => decide("reject")}>דחה עם הערה</button>
      </div>
    </div>
  );
}

function EditForm({ t, onSave, onCancel }: { t: TaskRow; onSave: (title: string, description: string) => Promise<void>; onCancel: () => void }) {
  const [title, setTitle] = useState(taskTitle(t));
  const [description, setDescription] = useState(t.description);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    await onSave(title.trim(), description.trim());
    setBusy(false);
  }
  return (
    <form className="card" onSubmit={submit}>
      <label htmlFor="t">כותרת</label>
      <input id="t" value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} required />
      <label htmlFor="d">מה לבצע</label>
      <textarea id="d" rows={6} value={description} onChange={(e) => setDescription(e.target.value)} required />
      <div className="actions">
        <button className="primary" disabled={busy || !title.trim() || !description.trim()}>שמור</button>
        <button type="button" onClick={onCancel}>ביטול</button>
      </div>
    </form>
  );
}

/** The secondary actions that fit the task's state. Deleting needs a second tap. */
function Actions({ t, act, onEdit }: { t: TaskRow; act: (path: string, method?: string, body?: unknown) => Promise<void>; onEdit: () => void }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const canEdit = ["blocked", "stopped"].includes(t.status);
  const canDelete = !["received", "planning", "in_progress", "awaiting_approval"].includes(t.status);
  const settled = t.status === "merged" || t.status === "stopped";
  if (!canEdit && !canDelete && !settled) return null;
  return (
    <div className="actions">
      {canEdit && <button onClick={onEdit}>ערוך</button>}
      {(settled || t.status === "blocked") && <button onClick={() => act("/duplicate")}>שכפל</button>}
      {settled && !t.archived_at && <button onClick={() => act("/archive")}>לארכיון</button>}
      {t.archived_at && <button onClick={() => act("/unarchive")}>החזר מהארכיון</button>}
      {canDelete && (confirmDelete ? (
        <button className="danger solid" onClick={() => act("", "DELETE")}>כן, העבר לפח</button>
      ) : <button className="danger" onClick={() => setConfirmDelete(true)}>מחק</button>)}
    </div>
  );
}
