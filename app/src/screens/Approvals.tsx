import { useRef, useState } from "react";
import { useApi, useConnected, useTick } from "../hooks";
import { api, ApiError, uploadFile } from "../lib/api";
import { describeChange, relativeTime, STAGES, taskTitle, type FileChange, type TaskRow } from "../lib/format";
import { AiBadge, Icon, InnerBar, Sheet, Soon, StatusPill, TopBar } from "../ui";
import { useUndo, type MergeFailure } from "../undo";
import { coreMessage, errorText, State } from "./common";
import { clock, useVoice, useVoiceAvailable } from "../lib/voice";
import { AnnotatorSheet, loadMarkSource, type MarkSource } from "./Annotate";
import { AttachmentChips, MAX_FILES } from "./media";
import { LiveEnvironment, PreviewFrame, useShots } from "./Preview";

export interface ApprovalRow {
  id: number;
  task_id: number;
  /** "plan": the plan before building. "work": the finished change before merging. */
  kind: "plan" | "work";
  request_text: string;
  reminders_sent: number;
  created_at: string;
}

/**
 * Approve with the 5 second undo window: the list shows the task as merged at once, and the call to the core
 * goes out only when the window ends. A failed merge (409) opens the approval screen with what to do next.
 */
export function useApprove() {
  const { schedule, setMergeError, notify } = useUndo();
  return (a: Pick<ApprovalRow, "id" | "task_id" | "kind">, opts: { stash?: boolean } = {}) => {
    setMergeError(a.id, null);
    const plan = a.kind === "plan";
    schedule({
      text: plan ? `התוכנית של משימה #${a.task_id} אושרה. הבנייה מתחילה` : `משימה #${a.task_id} אושרה ותמוזג`,
      task: { id: a.task_id, patch: { status: plan ? "in_progress" : "merged" } },
      approvalId: a.id,
      commit: async () => {
        const res = await api<{ warning?: string }>(`/approvals/${a.id}`, { method: "POST", body: { decision: "approve", stash: opts.stash } });
        if (res?.warning) notify(res.warning);
      },
      onError: (err) => {
        if (err instanceof ApiError && err.status === 409) {
          const message = coreMessage(err) ?? "המיזוג נכשל.";
          setMergeError(a.id, { message, reason: (err.body as { reason?: string } | null)?.reason ?? null });
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
                  <div className="row between"><StatusPill status="awaiting_approval" label={a.kind === "plan" ? "תוכנית ממתינה לאישור" : undefined} /><span className="muted">{relativeTime(a.created_at, now)}</span></div>
                  <div className="ttl clamp2">{task ? taskTitle(task) : `משימה #${a.task_id}`}</div>
                  <div className="txt clamp2 pre">{a.request_text}</div>
                  <div className="row">
                    <button type="button" className="btn pri grow" disabled={!connected} onClick={() => approve(a)}>{a.kind === "plan" ? "אשר והתחל" : "אשר ומזג"}</button>
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
          return <Detail a={a} failure={mergeErrors[id]} />;
        }}
      </State>
    </>
  );
}

function Detail({ a, failure }: { a: ApprovalRow; failure: MergeFailure | undefined }) {
  const task = useApi<TaskRow>(`/tasks/${a.task_id}`);
  const approve = useApprove();
  const connected = useConnected();
  const { notify } = useUndo();
  const [rejecting, setRejecting] = useState(false);
  const { shots } = useShots(a.task_id);
  const changes = useApi<FileChange[]>(`/tasks/${a.task_id}/changes`);

  function approveAndLeave(stash = false) {
    approve(a, { stash });
    window.location.hash = "#/approvals";
  }

  return (
    <>
      <div className="body has-bar">
        <div className="group">
          <StatusPill status="awaiting_approval" label={a.kind === "plan" ? "תוכנית ממתינה לאישור" : undefined} />
          <h1 className="h1s">{task.data ? taskTitle(task.data) : `משימה #${a.task_id}`}</h1>
          {task.data && <div className="row wrap"><AiBadge model={task.data.ai} /><span className="muted"><bdi>{task.data.project_name}</bdi></span></div>}
        </div>

        {failure && <MergeFailed failure={failure} approval={a} onRetry={() => approveAndLeave()} onStash={() => approveAndLeave(true)} />}

        <div className="card">
          <h2 className="h2">{a.kind === "plan" ? "התוכנית" : "מה נעשה"}</h2>
          <p className="txt pre">{a.request_text}</p>
        </div>

        {a.kind === "work" && changes.data && changes.data.length > 0 && (
          <div className="card">
            <h2 className="h2">קבצים ששונו ({changes.data.length})</h2>
            {changes.data.map((c) => (
              <div key={c.path} className="row between" style={{ alignItems: "flex-start" }}>
                <bdi className="mono" style={{ overflowWrap: "anywhere" }}>{c.path}</bdi>
                <span className="muted" style={{ textAlign: "left", flex: "none" }}>{describeChange(c)}</span>
              </div>
            ))}
          </div>
        )}

        {a.kind === "work" && <LiveEnvironment taskId={a.task_id} />}

        {a.kind === "work" && shots.size > 0 && (
          <div className="card">
            <h2 className="h2">איך זה נראה</h2>
            <PreviewFrame taskId={a.task_id} shots={shots} />
          </div>
        )}

        <div className="card">
          <h2 className="h2">איפה זה בתהליך</h2>
          <div className="muted">{a.kind === "plan" ? `שלב ${STAGES[0]}: המתכנן סיים, והבונה יתחיל רק אחרי שתאשר.` : `שלב ${STAGES[2]}: הבונה סיים, ומחכים להחלטה שלך.`}</div>
          <a className="btn ghost" style={{ alignSelf: "flex-start" }} href={`#/tasks/${a.task_id}`}>למשימה</a>
        </div>
      </div>
      <div className="bar-fixed">
        <button type="button" className="btn pri big" disabled={!connected} onClick={() => approveAndLeave()}><Icon name="check" color="#fff" width={2.6} />{a.kind === "plan" ? "אשר והתחל לבנות" : "אשר ומזג"}</button>
        <button type="button" className="btn" disabled={!connected} onClick={() => setRejecting(true)}>{a.kind === "plan" ? "בקש שינוי בתוכנית" : "בקש תיקון (דחה עם הערה)"}</button>
      </div>
      {rejecting && (
        <RejectSheet
          plan={a.kind === "plan"}
          taskId={a.task_id}
          shots={[...shots.values()].filter((s) => s.name.startsWith("after-"))}
          onClose={() => setRejecting(false)}
          onSend={async (note, marked) => {
            try {
              // The marked screenshots become files of the task first, so the builder finds them on its next run.
              for (const f of marked) await uploadFile(a.task_id, f);
              await api(`/approvals/${a.id}`, { method: "POST", body: { decision: "reject", note } });
              notify(a.kind === "plan" ? "נשלח למתכנן עם ההערה" : "נשלח לבונה עם ההערה");
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
function MergeFailed({ failure, approval, onRetry, onStash }: { failure: MergeFailure; approval: ApprovalRow; onRetry: () => void; onStash: () => void }) {
  return (
    <>
      <div className="card">
        <h2 className="h2">למה המיזוג נכשל</h2>
        <p className="txt pre">{failure.message}</p>
      </div>
      <div className="group">
        <h2 className="h2">מה לעשות</h2>
        {failure.reason === "dirty" && (
          <button type="button" className="card strong" onClick={onStash}>
            <div className="row"><span className="ttl">שמור אותם בצד ומזג</span><span className="ai rec">מומלץ</span></div>
            <div className="muted">השינויים שלך יישמרו בצד, המשימה תמוזג והם יחזרו למקום. לחיצה אחת.</div>
          </button>
        )}
        <button type="button" className="card" onClick={onRetry}><div className="ttl">נסה שוב</div><div className="muted">אחרי ששמרת את השינויים בפרויקט בעצמך</div></button>
        <a className="card" href={`#/chat?q=${encodeURIComponent(`המיזוג של משימה #${approval.task_id} נכשל. מה לעשות?`)}`}><div className="ttl">שאל את המתפעל</div><div className="muted">תסביר לו במילים מה לעשות</div></a>
      </div>
    </>
  );
}

function RejectSheet({ onClose, onSend, plan, taskId, shots }: { onClose: () => void; onSend: (note: string, marked: File[]) => Promise<void>; plan: boolean; taskId: number; shots: { id: number; name: string }[] }) {
  const [note, setNote] = useState("");
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [marked, setMarked] = useState<File[]>([]);
  const [drawing, setDrawing] = useState<Blob | null>(null);
  const pick = useRef<HTMLInputElement>(null);
  const { notify } = useUndo();
  const available = useVoiceAvailable();
  const voice = useVoice((text) => { setNote((n) => (n.trim() ? `${n.trimEnd()}\n${text}` : text)); setError(false); }, notify);
  async function startMarking(src: MarkSource) {
    try {
      setDrawing(await loadMarkSource(src));
    } catch (err) {
      notify(errorText(err));
    }
  }
  async function send() {
    // A marked screenshot is a complete request on its own; the text is only required when there is none.
    if (note.trim() === "" && marked.length === 0) return setError(true);
    setBusy(true);
    await onSend(note.trim() || "ראה את הצילום עם הסימון.", marked);
    setBusy(false);
  }
  return (
    <Sheet title={plan ? "מה לשנות בתוכנית?" : "מה לתקן?"} onClose={onClose}>
      <textarea className="field" style={{ height: 110 }} aria-label="הערה לבונה" placeholder={plan ? "למשל: בלי כפתור חדש, רק לשנות את הכותרת" : "למשל: הכותרת ארוכה מדי בנייד"} value={note} onChange={(e) => { setNote(e.target.value); setError(false); }} />
      {error && <span className="err" role="alert">דחייה דורשת הערה, הקלטה או צילום מסומן</span>}
      <AttachmentChips files={marked} onRemove={(i) => setMarked(marked.filter((_, j) => j !== i))} />
      {drawing && <AnnotatorSheet source={drawing} onClose={() => setDrawing(null)} onDone={(file) => { setMarked((m) => [...m, file]); setDrawing(null); setError(false); }} />}
      <div className="row wrap">
        <input ref={pick} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void startMarking({ kind: "file", file: f }); }} />
        <button type="button" className="chip" disabled={marked.length >= MAX_FILES} onClick={() => pick.current?.click()}>צילום מסך עם סימון</button>
        {shots.map((s) => (
          <button key={s.id} type="button" className="chip" disabled={marked.length >= MAX_FILES} onClick={() => void startMarking({ kind: "shot", taskId, mediaId: s.id })}>
            {s.name.includes("phone") ? "סמן על התוצר בנייד" : "סמן על התוצר במחשב"}
          </button>
        ))}
        <button type="button" className={`chip ${voice.state === "recording" ? "recording" : ""}`} disabled={!available || voice.state === "transcribing"} aria-pressed={voice.state === "recording"} onClick={voice.toggle}>
          {voice.state === "recording" ? `עצור (${clock(voice.seconds)})` : voice.state === "transcribing" ? "מתמלל…" : available ? "הקלטה" : "הקלטה (לא מותקן)"}
        </button>
      </div>
      <div className="row">
        <button type="button" className="btn pri grow" disabled={busy} onClick={send}>{plan ? "שלח למתכנן" : "שלח לבונה"}</button>
        <button type="button" className="btn grow" onClick={onClose}>ביטול</button>
      </div>
    </Sheet>
  );
}
