import { useState } from "react";
import { useApi } from "../hooks";
import { api } from "../lib/api";
import type { TaskRow } from "../lib/format";
import { errorText, State } from "./common";

/** Adds a project without the terminal: the computer shows its own folder dialog and the chosen folder is registered. */
function AddProject({ onAdded }: { onAdded: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  async function add() {
    setBusy(true);
    setMsg(null);
    try {
      const { path } = await api<{ path: string | null }>("/projects/pick", { method: "POST", body: {} });
      if (path) {
        const res = await api<{ warnings: string[] }>("/projects", { method: "POST", body: { path } });
        setMsg(res.warnings.length > 0 ? res.warnings.join(". ") : "הפרויקט נוסף ✓");
        onAdded();
      }
    } catch (err) {
      setMsg(errorText(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="card">
      <button className="primary" disabled={busy} onClick={add}>{busy ? "בחר תיקייה בחלון שנפתח במחשב…" : "＋ הוסף פרויקט מהמחשב"}</button>
      <span className="muted small">נפתח חלון בחירת תיקייה במחשב. התיקייה צריכה להיות ריפו של git. זמין רק כשמשתמשים באפליקציה מהמחשב עצמו.</span>
      {msg && <p className={msg.endsWith("✓") ? "muted" : "error"} role="status">{msg}</p>}
    </div>
  );
}

function OpenButtons({ id }: { id: number }) {
  const [msg, setMsg] = useState<string | null>(null);
  async function open(target: "folder" | "editor") {
    setMsg(null);
    try {
      await api(`/projects/${id}/open`, { method: "POST", body: { target } });
    } catch (err) {
      setMsg(errorText(err));
    }
  }
  return (
    <>
      <div className="actions">
        <button onClick={() => open("folder")}>פתח תיקייה</button>
        <button onClick={() => open("editor")}>פתח בעורך</button>
      </div>
      {msg && <p className="error" role="alert">{msg}</p>}
    </>
  );
}

export function ProjectsScreen() {
  const projects = useApi<{ id: number; name: string; repo_path: string }[]>("/projects");
  const tasks = useApi<TaskRow[]>("/tasks?view=active");
  return (
    <>
      <h2>פרויקטים</h2>
      <AddProject onAdded={projects.reload} />
      <State q={projects}>
        {(list) => list.length === 0 ? <p className="muted">אין פרויקטים רשומים.</p> : (
          <ul className="list">
            {list.map((p) => {
              const mine = (tasks.data ?? []).filter((t) => t.project_id === p.id);
              const open = mine.filter((t) => !["merged", "stopped"].includes(t.status)).length;
              return (
                <li key={p.id} className="card">
                  <div className="row between">
                    <strong>{p.name}</strong>
                    <span className="muted small">{open > 0 ? `${open} משימות פתוחות` : "אין משימות פתוחות"}</span>
                  </div>
                  <p className="muted small path"><bdi>{p.repo_path}</bdi></p>
                  <a className="pill" href={`#/new?project=${p.id}`}>+ משימה חדשה בפרויקט</a>
                  <OpenButtons id={p.id} />
                </li>
              );
            })}
          </ul>
        )}
      </State>
    </>
  );
}
