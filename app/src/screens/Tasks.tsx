import { useState } from "react";
import { useApi, useTick } from "../hooks";
import { api } from "../lib/api";
import { activityLabel, formatNumber, GROUPS, RUNNING, relativeTime, taskTitle, type GroupKey, type TaskRow } from "../lib/format";
import { errorText, State, TaskCard } from "./common";

interface ActivityRow { id: number; agent: string; tool: string; target: string | null; created_at: string }

const VIEW_TITLES = { archived: "ארכיון", trash: "פח (נמחק אחרי 30 יום)" } as const;

export function TasksScreen({ view = "active" }: { view?: "active" | "archived" | "trash" }) {
  const tasks = useApi<TaskRow[]>(`/tasks?view=${view}`);
  const now = useTick();
  const [group, setGroup] = useState<GroupKey | null>(null);

  return (
    <State q={tasks}>
      {(rows) => {
        if (view !== "active") return <SimpleList rows={rows} view={view} now={now} reload={tasks.reload} />;
        const inGroup = (g: GroupKey) => rows.filter((t) => (GROUPS[g].statuses as readonly string[]).includes(t.status));
        // Open on the group that needs attention first; the owner can still pick another one.
        const current: GroupKey = group ?? (inGroup("needs").length > 0 ? "needs" : inGroup("active").length > 0 ? "active" : "done");
        const running = rows.find((t) => RUNNING.has(t.status));
        const queue = rows.filter((t) => t.status === "received").sort((a, b) => a.id - b.id);
        const shown = inGroup(current);
        return (
          <>
            {running ? <NowCard task={running} now={now} /> : <IdleCard />}
            <div className="seg" role="tablist" aria-label="קבוצות משימות">
              {(Object.keys(GROUPS) as GroupKey[]).map((g) => (
                <button key={g} role="tab" aria-selected={current === g} onClick={() => setGroup(g)}>
                  {GROUPS[g].label}
                  <span className={`count ${g === "needs" && inGroup(g).length > 0 ? "hot" : ""}`}>{inGroup(g).length}</span>
                </button>
              ))}
            </div>
            {shown.length === 0 ? (
              <p className="muted">{current === "needs" ? "אין כלום שמחכה לך." : current === "active" ? "אין משימות בעבודה." : "עוד לא הסתיימה אף משימה."}</p>
            ) : (
              <ul className="list">
                {shown.map((t) => (
                  <li key={t.id}><TaskCard t={t} now={now} queue={t.status === "received" ? queue.indexOf(t) + 1 : undefined} /></li>
                ))}
              </ul>
            )}
            <div className="row small">
              <a href="#/list/archived">ארכיון</a><span className="muted">·</span><a href="#/list/trash">פח</a>
            </div>
          </>
        );
      }}
    </State>
  );
}

/** The one task being worked on right now, with what the agent is doing this second. */
function NowCard({ task, now }: { task: TaskRow; now: number }) {
  const feed = useApi<ActivityRow[]>(`/tasks/${task.id}/activity`);
  const last = feed.data?.[feed.data.length - 1];
  const stage = task.status === "planning" ? "מתכנן" : "בונה";
  return (
    <a className="card now" href={`#/tasks/${task.id}`} aria-label="המשימה שרצה עכשיו">
      <div className="row between">
        <span className="muted small"><span className="live-dot pulse" />רץ עכשיו · {stage}</span>
        <span className="pill">{task.project_name}</span>
      </div>
      <strong>{taskTitle(task)}</strong>
      <span className="doing">
        {last ? <>{activityLabel(last.tool)} {last.target && <bdi>{last.target}</bdi>}</> : "הסוכן מתחיל לעבוד…"}
      </span>
      <span className="muted small">התחיל {relativeTime(task.created_at, now)} · {formatNumber(task.tokens_used)} טוקנים</span>
    </a>
  );
}

function IdleCard() {
  return (
    <div className="card flat">
      <strong>אף סוכן לא עובד כרגע</strong>
      <span className="muted small">פתח משימה חדשה והסוכן יתחיל, אפשר לראות כאן בזמן אמת מה הוא עושה.</span>
    </div>
  );
}

function SimpleList({ rows, view, now, reload }: { rows: TaskRow[]; view: "archived" | "trash"; now: number; reload: () => void }) {
  const [error, setError] = useState<string | null>(null);
  async function undo(id: number) {
    try {
      await api(`/tasks/${id}/${view === "trash" ? "restore" : "unarchive"}`, { method: "POST", body: {} });
      reload();
    } catch (err) {
      setError(errorText(err));
    }
  }
  return (
    <>
      <a className="back" href="#/tasks">‹ חזרה</a>
      <h2>{VIEW_TITLES[view]}</h2>
      {error && <p className="error" role="alert">{error}</p>}
      {rows.length === 0 ? <p className="muted">ריק.</p> : (
        <ul className="list">
          {rows.map((t) => (
            <li key={t.id} className="stack">
              <TaskCard t={t} now={now} />
              <button onClick={() => undo(t.id)}>{view === "trash" ? "שחזר" : "החזר מהארכיון"}</button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
