import { useState } from "react";
import { useApi, useConnected, useTick } from "../hooks";
import { api } from "../lib/api";
import { activityLabel, formatNumber, GROUPS, parseDbDate, RUNNING, taskTitle, type GroupKey, type TaskRow } from "../lib/format";
import { Icon, InnerBar, StatusPill, TopBar } from "../ui";
import { useUndo } from "../undo";
import { errorText, State, TaskCard } from "./common";

interface ActivityRow { id: number; agent: string; tool: string; target: string | null; created_at: string }
interface UsageWindow { input_tokens: number; output_tokens: number }
interface Usage { last_5h: UsageWindow }

const VIEW_TITLES = { archived: "ארכיון", trash: "פח (נמחק אחרי 30 יום)" } as const;

export function TasksScreen() {
  const tasks = useApi<TaskRow[]>("/tasks?view=active");
  const usage = useApi<Usage>("/usage");
  const { applyTask } = useUndo();
  const now = useTick();
  const [group, setGroup] = useState<GroupKey | null>(null);

  return (
    <>
      <TopBar title="משימות">
        <a className="iconbtn" href="#/settings" aria-label="הגדרות"><Icon name="settings" /></a>
      </TopBar>
      <div className="body has-fab">
        <State q={tasks} skeletons={3}>
          {(all) => {
            const rows = all.map(applyTask).filter((t) => t.deleted_at === null);
            const inGroup = (g: GroupKey) => rows.filter((t) => (GROUPS[g].statuses as readonly string[]).includes(t.status));
            // Open on the group that needs attention first; the owner can still pick another one.
            const current: GroupKey = group ?? (inGroup("needs").length > 0 ? "needs" : inGroup("active").length > 0 ? "active" : "done");
            const running = rows.find((t) => RUNNING.has(t.status));
            const queue = rows.filter((t) => t.status === "received" && !t.scheduled_for).sort((a, b) => a.id - b.id);
            const shown = inGroup(current);
            const tokens = usage.data ? usage.data.last_5h.input_tokens + usage.data.last_5h.output_tokens : null;
            return (
              <>
                <DigestCard rows={rows} tokens={tokens} />
                <div className="group">
                  <h2 className="h2">רץ עכשיו</h2>
                  {running ? <NowCard task={running} /> : <div className="card"><div className="muted">אף סוכן לא עובד כרגע</div></div>}
                </div>
                <div className="seg" role="tablist" aria-label="קבוצות משימות">
                  {(Object.keys(GROUPS) as GroupKey[]).map((g) => (
                    <button key={g} type="button" role="tab" aria-selected={current === g} onClick={() => setGroup(g)}>{GROUPS[g].label} ({inGroup(g).length})</button>
                  ))}
                </div>
                <div className="list">
                  {shown.map((t) => <TaskCard key={t.id} t={t} now={now} queue={t.status === "received" && !t.scheduled_for ? queue.indexOf(t) + 1 : undefined} />)}
                  {shown.length === 0 && <div className="card"><div className="muted">אין כאן משימות כרגע</div></div>}
                </div>
                <div className="row" style={{ justifyContent: "center", gap: 18 }}>
                  <a className="btn ghost" href="#/list/archived">ארכיון</a>
                  <a className="btn ghost" href="#/list/trash">פח</a>
                </div>
              </>
            );
          }}
        </State>
      </div>
      <a className="fab" href="#/new"><Icon name="plus" size={18} color="#fff" width={2.4} />משימה חדשה</a>
    </>
  );
}

/** Today at a glance. The detail comes from the operator in the chat, so the button just asks it. */
function DigestCard({ rows, tokens }: { rows: TaskRow[]; tokens: number | null }) {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const done = rows.filter((t) => t.status === "merged" && parseDbDate(t.updated_at) >= startOfDay).length;
  const waiting = rows.filter((t) => (GROUPS.needs.statuses as readonly string[]).includes(t.status)).length;
  const working = rows.filter((t) => (GROUPS.active.statuses as readonly string[]).includes(t.status)).length;
  const connected = useConnected();
  return (
    <div className="card summary">
      <div className="row between"><span className="h2">הסיכום של היום</span></div>
      <div style={{ fontSize: 15, lineHeight: 1.6 }}>
        {done} הושלמו · {waiting} מחכות לך · {working} בעבודה
      </div>
      <div className="row wrap">
        <a className="btn sm on-dark" href={`#/chat?q=${encodeURIComponent("סכם לי את היום")}`} aria-disabled={!connected}>פרט לי בצ'אט</a>
        {tokens !== null && <span className="muted">{formatNumber(tokens)} טוקנים ב-5 השעות האחרונות</span>}
      </div>
    </div>
  );
}

/** The one task being worked on right now, with what the agent is doing this second. */
function NowCard({ task }: { task: TaskRow }) {
  const feed = useApi<ActivityRow[]>(`/tasks/${task.id}/activity`);
  const last = feed.data?.[feed.data.length - 1];
  const stage = task.status === "planning" ? "המתכנן" : "הבונה";
  return (
    <a className="card" href={`#/tasks/${task.id}`} aria-label="המשימה שרצה עכשיו">
      <div className="row between"><StatusPill status={task.status} /><span className="muted mono">#{task.id}</span></div>
      <div className="ttl clamp2">{taskTitle(task)}</div>
      <div style={{ fontSize: 14, color: "var(--ink-3)" }}>
        {last ? <>{stage} {activityLabel(last.tool)} {last.target && <bdi className="mono">{last.target}</bdi>}</> : `${stage} מתחיל לעבוד…`}
      </div>
      <div className="muted"><bdi>{task.project_name}</bdi> · {formatNumber(task.tokens_used)} טוקנים</div>
    </a>
  );
}

/** Archive and trash: finished tasks with the one action that brings them back. */
export function ListScreen({ view }: { view: "archived" | "trash" }) {
  const tasks = useApi<TaskRow[]>(`/tasks?view=${view}`);
  const now = useTick();
  const connected = useConnected();
  const { notify } = useUndo();
  async function undo(id: number) {
    try {
      await api(`/tasks/${id}/${view === "trash" ? "restore" : "unarchive"}`, { method: "POST", body: {} });
      tasks.reload();
    } catch (err) {
      notify(errorText(err));
    }
  }
  return (
    <>
      <InnerBar fallback="/tasks" />
      <div className="body">
        <h1 className="h1s">{VIEW_TITLES[view]}</h1>
        <State q={tasks}>
          {(rows) => rows.length === 0 ? <div className="card"><div className="muted">ריק</div></div> : (
            <ul className="list">
              {rows.map((t) => (
                <li key={t.id} className="group">
                  <TaskCard t={t} now={now} />
                  <button type="button" className="btn" disabled={!connected} onClick={() => undo(t.id)}>{view === "trash" ? "שחזר" : "החזר מהארכיון"}</button>
                </li>
              ))}
            </ul>
          )}
        </State>
      </div>
    </>
  );
}
