import { useState } from "react";
import { useApi, useConnected, useTick } from "../hooks";
import { api } from "../lib/api";
import { activityLabel, formatDate, formatNumber, parseDbDate, RUNNING, relativeTime, STAGES, stageOf, stepLabel, taskTitle, type TaskRow } from "../lib/format";
import { InnerBar, Soon, StatusPill, Stepper } from "../ui";
import { useUndo } from "../undo";
import { errorText, State } from "./common";
import { TaskGallery } from "./media";

interface ActivityRow { id: number; agent: string; tool: string; target: string | null; created_at: string }
interface StepRow { id: number; agent: string; status: string; from_status: string | null; to_status: string | null; summary: string | null; created_at: string }
interface ApprovalRow { id: number; task_id: number; request_text: string; reminders_sent: number; created_at: string }

type Act = (path: string, method?: string, body?: unknown) => Promise<void>;
const TABS = [["overview", "סקירה"], ["preview", "תצוגה"], ["gallery", "גלריה"], ["history", "היסטוריה"]] as const;
type TabKey = (typeof TABS)[number][0];

export function TaskScreen({ id }: { id: number }) {
  const task = useApi<TaskRow>(`/tasks/${id}`);
  return (
    <>
      <InnerBar fallback="/tasks"><span className="muted mono">#{id}</span></InnerBar>
      <State q={task} skeletons={3}>{(t) => <TaskView base={t} reload={task.reload} />}</State>
    </>
  );
}

const hhmm = (value: string) => parseDbDate(value).toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit", hour12: false });

function TaskView({ base, reload }: { base: TaskRow; reload: () => void }) {
  const { applyTask, schedule, notify } = useUndo();
  const t = applyTask(base);
  const steps = useApi<StepRow[]>(`/tasks/${t.id}/steps`);
  const feed = useApi<ActivityRow[]>(`/tasks/${t.id}/activity`);
  const approvals = useApi<ApprovalRow[]>("/approvals");
  const now = useTick();
  const connected = useConnected();
  const [tab, setTab] = useState<TabKey>("overview");
  const [editing, setEditing] = useState(false);

  /** Runs one action on the task and refreshes; the core answers 409 when the state no longer fits. */
  const act: Act = async (path, method = "POST", body = {}) => {
    try {
      const res = await api<{ id: number }>(`/tasks/${t.id}${path}`, { method, body });
      if (path === "/duplicate") window.location.hash = `#/tasks/${res.id}`;
      reload();
      steps.reload();
    } catch (err) {
      notify(errorText(err));
    }
  };
  const stop = () => schedule({ text: `משימה #${t.id} נעצרה`, task: { id: t.id, patch: { status: "stopped" } }, commit: () => api(`/tasks/${t.id}/stop`, { method: "POST", body: {} }) });
  const trash = () => {
    schedule({ text: `משימה #${t.id} הועברה לפח`, task: { id: t.id, patch: { deleted_at: new Date().toISOString() } }, commit: () => api(`/tasks/${t.id}`, { method: "DELETE", body: {} }) });
    window.location.hash = "#/tasks";
  };

  const approval = approvals.data?.find((a) => a.task_id === t.id);
  const stage = stageOf(t.status, (steps.data ?? []).map((s) => s.to_status));
  const running = RUNNING.has(t.status) || t.status === "received";
  const trashed = t.deleted_at !== null;
  const canEdit = ["blocked", "stopped"].includes(t.status);

  return (
    <div className="body">
      <div className="group">
        <StatusPill status={t.status} />
        <h1 className="h1s">{taskTitle(t)}</h1>
        <div className="muted"><bdi>{t.project_name}</bdi> · {formatNumber(t.tokens_used)} טוקנים</div>
      </div>
      <Stepper labels={STAGES} current={stage} status={t.status} />

      {trashed && (
        <div className="soft">
          <span>המשימה בפח. היא תימחק לצמיתות 30 יום אחרי המחיקה.</span>
          <button type="button" className="btn sm" disabled={!connected} onClick={() => act("/restore")}>שחזר</button>
        </div>
      )}

      {!trashed && t.status === "merged" && (
        <div className="card good">
          <div className="ttl" style={{ color: "var(--success-ink)" }}>השינוי מוזג לפרויקט</div>
          <p className="txt">אם משהו לא נראה טוב, אפשר להחזיר. נוצר שינוי הפוך, ושום דבר לא נמחק.</p>
          <div className="row"><button type="button" className="btn" disabled>החזר את המיזוג</button><Soon>עוד לא זמין</Soon></div>
        </div>
      )}

      {!trashed && t.status === "awaiting_approval" && approval && (
        <div className="card strong">
          <div className="ttl">מחכה להחלטה שלך</div>
          <p className="txt pre clamp2">{approval.request_text}</p>
          <a className="btn pri" href={`#/approvals/${approval.id}`}>לבקשת האישור</a>
        </div>
      )}

      {!trashed && (t.status === "blocked" || t.status === "stopped") && (
        <HaltedPanel t={t} act={act} onEdit={() => { setTab("overview"); setEditing(true); }} onTrash={trash} />
      )}

      <div className="tabs" role="tablist" aria-label="חלקי המשימה">
        {TABS.map(([key, label]) => <button key={key} type="button" role="tab" aria-selected={tab === key} onClick={() => setTab(key)}>{label}</button>)}
      </div>

      {tab === "overview" && (
        <>
          {running && !trashed && <LiveLog rows={feed.data ?? []} queued={t.status === "received"} />}
          <div className="card">
            <div className="row between">
              <h2 className="h2">מה ביקשתי</h2>
              {canEdit && !editing && !trashed && <button type="button" className="btn ghost sm" onClick={() => setEditing(true)}>ערוך</button>}
            </div>
            {editing
              ? <EditForm t={t} onCancel={() => setEditing(false)} onSave={async (title, description) => { await act("", "PATCH", { title, description }); setEditing(false); }} />
              : <p className="txt pre">{t.description}</p>}
          </div>
          {!trashed && <Actions t={t} act={act} connected={connected} onStop={stop} onTrash={trash} />}
          {!running && feed.data && feed.data.length > 0 && (
            <div className="card">
              <h2 className="h2">מה הסוכן עשה ({feed.data.length} פעולות)</h2>
              <FeedList rows={[...feed.data].reverse()} />
            </div>
          )}
          <LocationCard taskId={t.id} status={t.status} />
          <div className="card">
            <dl>
              <dt>ענף</dt><dd><bdi className="mono">{t.branch ?? "—"}</bdi></dd>
              <dt>טוקנים</dt><dd>{formatNumber(t.tokens_used)}</dd>
              <dt>נוצרה</dt><dd><bdi>{formatDate(t.created_at)}</bdi></dd>
              <dt>עודכנה</dt><dd>{relativeTime(t.updated_at, now)}</dd>
              <dt>מספר</dt><dd><span className="mono">#{t.id}</span></dd>
            </dl>
          </div>
        </>
      )}

      {tab === "preview" && (
        <div className="card center soon">
          <div className="ttl">עוד אין צילומים</div>
          <div className="muted">צילומי לפני ואחרי יופיעו כאן כשהמערכת תתחיל לצלם את התוצר אחרי כל בנייה. מה שכבר נוצר נמצא בגלריה. <span className="soon-tag">בקרוב</span></div>
        </div>
      )}

      {tab === "gallery" && <TaskGallery taskId={t.id} editable={!trashed && t.status !== "merged"} />}

      {tab === "history" && (
        <div className="card" style={{ gap: 14 }}>
          {(steps.data ?? []).length === 0 && <div className="muted">עדיין אין היסטוריה למשימה הזאת.</div>}
          {(steps.data ?? []).map((s) => {
            const tone = s.to_status === "blocked" || s.status === "agent_error" || s.status === "tests_failed" ? "bad" : s.to_status === "merged" || s.status === "tests_passed" ? "good" : s.to_status === "awaiting_approval" ? "need" : "";
            return (
              <div key={s.id} className="tl">
                <span className={`dot ${tone}`} aria-hidden="true" />
                <div className="group" style={{ gap: 2 }}>
                  <span style={{ fontSize: 14, fontWeight: 500 }}>{stepLabel(s)}</span>
                  {s.summary && s.summary !== "task created" && <span className="muted pre">{s.summary}</span>}
                  <bdi className="muted">{formatDate(s.created_at)}</bdi>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** What the agent is doing right now, newest first. */
function LiveLog({ rows, queued }: { rows: ActivityRow[]; queued: boolean }) {
  const recent = [...rows].reverse().slice(0, 6);
  return (
    <div className="card" style={{ gap: 2 }}>
      <div className="row between" style={{ marginBottom: 6 }}>
        <h2 className="h2">עכשיו</h2>
        <span className="live">{queued ? "בתור" : "מתעדכן"}</span>
      </div>
      {recent.length === 0 && <div className="muted">{queued ? "ממתינה לתורה." : "מחכה לפעולה הראשונה…"}</div>}
      {recent.map((r, i) => (
        <div key={r.id} className={`log ${i === 0 ? "now" : ""}`}>
          <b>{hhmm(r.created_at)}</b>
          <span>{activityLabel(r.tool)} {r.target && <bdi className="mono">{r.target}</bdi>}</span>
        </div>
      ))}
    </div>
  );
}

function FeedList({ rows }: { rows: ActivityRow[] }) {
  return (
    <div style={{ maxHeight: "46vh", overflowY: "auto" }}>
      {rows.map((r) => (
        <div key={r.id} className="log">
          <b>{hhmm(r.created_at)}</b>
          <span>{activityLabel(r.tool)} {r.target && <bdi className="mono">{r.target}</bdi>} <span className="muted">· {r.agent === "planner" ? "מתכנן" : r.agent === "builder" ? "בונה" : "מערכת"}</span></span>
        </div>
      ))}
    </div>
  );
}

/** Blocked or stopped: why, in plain words, and what can be done, with the simplest way forward first. */
function HaltedPanel({ t, act, onEdit, onTrash }: { t: TaskRow; act: Act; onEdit: () => void; onTrash: () => void }) {
  const [note, setNote] = useState("");
  const connected = useConnected();
  const blocked = t.status === "blocked";
  return (
    <>
      <div className="card">
        <h2 className="h2">{blocked ? "למה היא נתקעה" : "למה היא נעצרה"}</h2>
        <p className="txt pre">{t.reason ?? (blocked ? "הסוכן לא הצליח להמשיך." : "המשימה נעצרה.")}</p>
      </div>
      <div className="group">
        <h2 className="h2">מה לעשות</h2>
        <div className="card strong">
          <div className="row"><span className="ttl">המשך מאותו מקום</span><span className="ai rec">מומלץ</span></div>
          <label className="muted" htmlFor="continue-note">הערה לסוכן (לא חובה)</label>
          <textarea id="continue-note" className="field" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="למשל: תשתמש בשם הקובץ index.html" />
          <button type="button" className="btn pri" disabled={!connected} onClick={() => act("/continue", "POST", { note })}>המשך</button>
        </div>
        <a className="card" href={`#/chat?q=${encodeURIComponent(`למה משימה #${t.id} ${blocked ? "נתקעה" : "נעצרה"} ומה כדאי לעשות?`)}`}>
          <div className="ttl">שאל את המתפעל</div><div className="muted">תסביר לו במילים מה לעשות</div>
        </a>
      </div>
      <div className="row">
        <button type="button" className="btn grow" onClick={onEdit}>ערוך ותכנן מחדש</button>
        <button type="button" className="btn dan grow" disabled={!connected} onClick={onTrash}>מחק</button>
      </div>
    </>
  );
}

/** Where the work is on the computer, with one-tap buttons. The buttons only work from the computer itself, not the phone. */
function LocationCard({ taskId, status }: { taskId: number; status: string }) {
  const where = useApi<{ path: string; kind: "worktree" | "project"; exists: boolean }>(`/tasks/${taskId}/location`);
  const { notify } = useUndo();
  const [copied, setCopied] = useState(false);
  if (!where.data) return null;
  const { path, kind, exists } = where.data;
  async function open(target: "folder" | "editor") {
    try {
      await api(`/tasks/${taskId}/open`, { method: "POST", body: { target } });
    } catch (err) {
      notify(errorText(err));
    }
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(path);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      notify("ההעתקה לא נתמכת כאן. הנתיב מוצג בכרטיס.");
    }
  }
  return (
    <div className="card">
      <h2 className="h2">{kind === "worktree" ? "איפה העבודה נמצאת" : status === "merged" ? "השינוי מוזג לפרויקט" : "תיקיית הפרויקט"}</h2>
      <p className="muted path"><bdi className="mono">{path}</bdi></p>
      {exists ? (
        <div className="actions">
          <button type="button" className="btn pri sm" onClick={() => open("folder")}>פתח תיקייה</button>
          <button type="button" className="btn sm" onClick={() => open("editor")}>פתח בעורך</button>
          <button type="button" className="btn ghost sm" onClick={copy}>{copied ? "הועתק" : "העתק נתיב"}</button>
        </div>
      ) : <p className="muted">התיקייה כבר לא קיימת.</p>}
    </div>
  );
}

function EditForm({ t, onSave, onCancel }: { t: TaskRow; onSave: (title: string, description: string) => Promise<void>; onCancel: () => void }) {
  const [title, setTitle] = useState(taskTitle(t));
  const [description, setDescription] = useState(t.description);
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true);
    await onSave(title.trim(), description.trim());
    setBusy(false);
  }
  return (
    <>
      <label className="label" htmlFor="edit-title">כותרת</label>
      <input id="edit-title" className="field" value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} />
      <label className="label" htmlFor="edit-desc">מה לבצע</label>
      <textarea id="edit-desc" className="field" style={{ height: 140 }} value={description} onChange={(e) => setDescription(e.target.value)} />
      <div className="muted">השינוי נשמר מיד ויגיע לסוכן כשתמשיך את המשימה.</div>
      <div className="row">
        <button type="button" className="btn pri grow" disabled={busy || !title.trim() || !description.trim()} onClick={submit}>שמור</button>
        <button type="button" className="btn grow" onClick={onCancel}>ביטול</button>
      </div>
    </>
  );
}

/** The secondary actions that fit the task's state. Stop and delete have the 5 second undo window instead of a second tap. */
function Actions({ t, act, connected, onStop, onTrash }: { t: TaskRow; act: Act; connected: boolean; onStop: () => void; onTrash: () => void }) {
  const stoppable = ["received", "planning", "in_progress", "awaiting_approval"].includes(t.status);
  const settled = t.status === "merged" || t.status === "stopped";
  const canDuplicate = settled || t.status === "blocked";
  const canDelete = t.status === "merged"; // blocked and stopped tasks have delete in their own panel
  return (
    <div className="row wrap">
      {stoppable && <button type="button" className="btn dan" disabled={!connected} onClick={onStop}>עצור</button>}
      {canDuplicate && <button type="button" className="btn" disabled={!connected} onClick={() => act("/duplicate")}>שכפל</button>}
      <a className="btn" href={`#/chat?q=${encodeURIComponent(`ספר לי על משימה #${t.id}`)}`}>שאל את המתפעל</a>
      {settled && !t.archived_at && <button type="button" className="btn" disabled={!connected} onClick={() => act("/archive")}>לארכיון</button>}
      {t.archived_at && <button type="button" className="btn" disabled={!connected} onClick={() => act("/unarchive")}>החזר מהארכיון</button>}
      {canDelete && <button type="button" className="btn dan" disabled={!connected} onClick={onTrash}>מחק</button>}
    </div>
  );
}
