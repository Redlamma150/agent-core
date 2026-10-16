import { useState } from "react";
import { useApi, useConnected } from "../hooks";
import { api } from "../lib/api";
import type { TaskRow } from "../lib/format";
import { TopBar } from "../ui";
import { useUndo } from "../undo";
import { errorText, State } from "./common";

/** Adds a project without the terminal: the computer shows its own folder dialog and the chosen folder is registered. */
function AddProject({ onAdded }: { onAdded: () => void }) {
  const [busy, setBusy] = useState(false);
  const { notify } = useUndo();
  async function add() {
    setBusy(true);
    try {
      const { path } = await api<{ path: string | null }>("/projects/pick", { method: "POST", body: {} });
      if (path) {
        const res = await api<{ warnings: string[] }>("/projects", { method: "POST", body: { path } });
        notify(res.warnings.length > 0 ? res.warnings.join(". ") : "הפרויקט נוסף");
        onAdded();
      }
    } catch (err) {
      notify(errorText(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="card">
      <button type="button" className="btn dark" disabled={busy} onClick={add}>{busy ? "בחר תיקייה בחלון שנפתח במחשב…" : "הוסף פרויקט מהמחשב"}</button>
      <span className="muted">הוספת פרויקט זמינה מהמחשב בלבד. התיקייה צריכה להיות ריפו של git.</span>
    </div>
  );
}

function OpenButtons({ id }: { id: number }) {
  const { notify } = useUndo();
  async function open(target: "folder" | "editor") {
    try {
      await api(`/projects/${id}/open`, { method: "POST", body: { target } });
    } catch (err) {
      notify(errorText(err));
    }
  }
  return (
    <div className="row">
      <button type="button" className="btn sm grow" onClick={() => open("folder")}>פתח תיקייה</button>
      <button type="button" className="btn sm grow" onClick={() => open("editor")}>פתח בעורך</button>
    </div>
  );
}

export function ProjectsScreen() {
  const projects = useApi<{ id: number; name: string; repo_path: string }[]>("/projects");
  const tasks = useApi<TaskRow[]>("/tasks?view=active");
  const connected = useConnected();
  return (
    <>
      <TopBar title="פרויקטים" />
      <div className="body has-nav">
        <State q={projects}>
          {(list) => list.length === 0 ? <div className="card"><div className="muted">אין פרויקטים רשומים</div></div> : list.map((p) => {
            const open = (tasks.data ?? []).filter((t) => t.project_id === p.id && !["merged", "stopped"].includes(t.status)).length;
            return (
              <div key={p.id} className="card">
                <div className="row between"><span className="ttl mono" style={{ fontSize: 15 }}>{p.name}</span><span className="muted">{open} פתוחות</span></div>
                <div className="muted path"><bdi className="mono">{p.repo_path}</bdi></div>
                <div className="row">
                  <a className="btn sm grow" href={`#/new?project=${p.id}`}>משימה חדשה</a>
                  <button type="button" className="btn sm grow soon" disabled>תצוגה חיה</button>
                  <a className="btn sm grow" aria-disabled={!connected} href={`#/chat?q=${encodeURIComponent(`הצע לי שיפורי עיצוב לפרויקט ${p.name}`)}`}>הצע עיצוב</a>
                </div>
                <OpenButtons id={p.id} />
              </div>
            );
          })}
        </State>
        <AddProject onAdded={projects.reload} />
      </div>
    </>
  );
}
