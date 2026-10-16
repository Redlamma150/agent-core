import { useState } from "react";
import { useApi, useConnected, useTick } from "../hooks";
import { api, ApiError } from "../lib/api";
import { relativeTime, STAGES, taskTitle, type TaskRow } from "../lib/format";
import { Icon, InnerBar, Sheet, Soon, StatusPill, TopBar } from "../ui";
import { useUndo } from "../undo";
import { coreMessage, errorText, State } from "./common";

export interface ApprovalRow {
  id: number;
  task_id: number;
  request_text: string;
  reminders_sent: number;
  created_at: string;
}

/**
 * Approve with the 5 second undo window: the list shows the task as merged at once, and the call to the core
 * goes out only when the window ends. A failed merge (409) opens the approval screen with what to do next.
 */
export function useApprove() {
  const { schedule, setMergeError } = useUndo();
  return (a: Pick<ApprovalRow, "id" | "task_id">) => {
    setMergeError(a.id, null);
    schedule({
      text: `משימה #${a.task_id} אושרה ותמוזג`,
      task: { id: a.task_id, patch: { status: "merged" } },
      approvalId: a.id,
      commit: () => api(`/approvals/${a.id}`, { method: "POST", body: { decision: "approve" } }),
      onError: (err) => {
        if (err instanceof ApiError && err.status === 409) {
          const message = coreMessage(err) ?? "המיזוג נכשל.";
          setMergeError(a.id, message);
          window.location.hash = `#/approvals/${a.id}`;
          return "המיזוג נכשל. אפשר לראות למה ומה לעשות.";
        }
        return errorText(err);
      },
    });
  };
}

export function ApprovalsScreen() {
  const approvals = useApi<ApprovalRow[]>("/approvals");
  const tasks = useApi<TaskRow[]>("/tasks?view=active");
  const { approvalHidden } = useUndo();
  const approve = useApprove();
  const connected = useConnected();
  const now = useTick();
  return (
    <>
      <TopBar title="אישורים" />
      <div className="body has-nav">
        <State q={approvals}>
          {(all) => {
            const rows = all.filter((a) => !approvalHidden(a.id));
            if (rows.length === 0) {
              return <div className="card center"><div className="ttl">אין בקשות אישור ממתינות</div><div className="muted">תקבל התראה כשסוכן יסיים</div></div>;
            }
            return rows.map((a) => {
              const task = tasks.data?.find((t) => t.id === a.task_id);
              return (
                <div key={a.id} className="card">
                  <div className="row between"><StatusPill status="awaiting_approval" /><span className="muted">{relativeTime(a.created_at, now)}</span></div>
                  <div className="ttl clamp2">{task ? taskTitle(task) : `משימה #${a.task_id}`}</div>
                  <div className="txt clamp2 pre">{a.request_text}</div>
                  <div className="row">
                    <button type="button" className="btn pri grow" disabled={!connected} onClick={() => approve(a)}>אשר ומזג</button>
                    <a className="btn grow" href={`#/approvals/${a.id}`}>פתח</a>
                  </div>
                </div>
              );
            });
          }}
        </State>
      </div>
    </>
  );
}

export function ApprovalDetailScreen({ id }: { id: number }) {
  const approvals = useApi<ApprovalRow[]>("/approvals");
  const { approvalHidden, mergeErrors } = useUndo();
  return (
    <>
      <InnerBar fallback="/approvals"><span className="muted mono">#{approvals.data?.find((a) => a.id === id)?.task_id ?? ""}</span></InnerBar>
      <State q={approvals}>
        {(all) => {
          const a = all.find((x) => x.id === id);
          if (!a || approvalHidden(id)) {
            return (
              <div className="body">
                <div className="soft">הבקשה הזאת כבר טופלה.<a className="btn ghost" href="#/approvals">לאישורים</a></div>
              </div>
            );
          }
          return <Detail a={a} mergeError={mergeErrors[id]} />;
        }}
      </State>
    </>
  );
}

function Detail({ a, mergeError }: { a: ApprovalRow; mergeError: string | undefined }) {
  const task = useApi<TaskRow>(`/tasks/${a.task_id}`);
  const approve = useApprove();
  const connected = useConnected();
  const { notify } = useUndo();
  const [rejecting, setRejecting] = useState(false);

  function approveAndLeave() {
    approve(a);
    window.location.hash = "#/approvals";
  }

  return (
    <>
      <div className="body has-bar">
        <div className="group">
          <StatusPill status="awaiting_approval" />
          <h1 className="h1s">{task.data ? taskTitle(task.data) : `משימה #${a.task_id}`}</h1>
          {task.data && <div className="muted"><bdi>{task.data.project_name}</bdi></div>}
        </div>

        {mergeError && <MergeFailed message={mergeError} approval={a} onRetry={approveAndLeave} />}

        <div className="card">
          <h2 className="h2">מה נעשה</h2>
          <p className="txt pre">{a.request_text}</p>
        </div>

        <div className="card soon" aria-disabled="true">
          <div className="row between"><h2 className="h2">איך זה נראה</h2><span className="soon-tag">בקרוב</span></div>
          <p className="muted">צילומי לפני ואחרי יופיעו כאן כשהמערכת תתחיל לצלם את התוצר אחרי כל בנייה.</p>
        </div>

        <div className="card">
          <h2 className="h2">איפה זה בתהליך</h2>
          <div className="muted">שלב {STAGES[2]}: הבונה סיים, ומחכים להחלטה שלך.</div>
          <a className="btn ghost" style={{ alignSelf: "flex-start" }} href={`#/tasks/${a.task_id}`}>למשימה</a>
        </div>
      </div>
      <div className="bar-fixed">
        <button type="button" className="btn pri big" disabled={!connected} onClick={approveAndLeave}><Icon name="check" color="#fff" width={2.6} />אשר ומזג</button>
        <button type="button" className="btn" disabled={!connected} onClick={() => setRejecting(true)}>דחה עם הערה</button>
      </div>
      {rejecting && (
        <RejectSheet
          onClose={() => setRejecting(false)}
          onSend={async (note) => {
            try {
              await api(`/approvals/${a.id}`, { method: "POST", body: { decision: "reject", note } });
              notify("נשלח לבונה עם ההערה");
              window.location.hash = "#/approvals";
            } catch (err) {
              notify(errorText(err));
            }
            setRejecting(false);
          }}
        />
      )}
    </>
  );
}

/** A merge that failed: the reason in plain words, and the next step the owner can take. */
function MergeFailed({ message, approval, onRetry }: { message: string; approval: ApprovalRow; onRetry: () => void }) {
  return (
    <>
      <div className="card">
        <h2 className="h2">למה המיזוג נכשל</h2>
        <p className="txt pre">{message}</p>
      </div>
      <div className="group">
        <h2 className="h2">מה לעשות</h2>
        <div className="card strong soon" aria-disabled="true">
          <div className="row"><span className="ttl">שמור אותם בצד ומזג</span><span className="ai rec">מומלץ</span><span className="soon-tag">בקרוב</span></div>
          <div className="muted">השינויים שלך יישמרו בצד, המשימה תמוזג והם יחזרו למקום. עוד לא זמין בליבה.</div>
        </div>
        <button type="button" className="card" onClick={onRetry}><div className="ttl">נסה שוב</div><div className="muted">אחרי ששמרת את השינויים בפרויקט בעצמך</div></button>
        <a className="card" href={`#/chat?q=${encodeURIComponent(`המיזוג של משימה #${approval.task_id} נכשל. מה לעשות?`)}`}><div className="ttl">שאל את המתפעל</div><div className="muted">תסביר לו במילים מה לעשות</div></a>
      </div>
    </>
  );
}

function RejectSheet({ onClose, onSend }: { onClose: () => void; onSend: (note: string) => Promise<void> }) {
  const [note, setNote] = useState("");
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  async function send() {
    if (note.trim() === "") return setError(true);
    setBusy(true);
    await onSend(note.trim());
    setBusy(false);
  }
  return (
    <Sheet title="מה לתקן?" onClose={onClose}>
      <textarea className="field" style={{ height: 110 }} aria-label="הערה לבונה" placeholder="למשל: הכותרת ארוכה מדי בנייד" value={note} onChange={(e) => { setNote(e.target.value); setError(false); }} />
      {error && <span className="err" role="alert">דחייה דורשת הערה</span>}
      <div className="row wrap"><Soon>צילום מסך עם סימון</Soon><Soon>הקלטה</Soon></div>
      <div className="row">
        <button type="button" className="btn pri grow" disabled={busy} onClick={send}>שלח לבונה</button>
        <button type="button" className="btn grow" onClick={onClose}>ביטול</button>
      </div>
    </Sheet>
  );
}
