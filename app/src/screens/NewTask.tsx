import { useEffect, useState, type FormEvent } from "react";
import { useApi } from "../hooks";
import { api } from "../lib/api";
import { errorText, State } from "./common";

interface Project { id: number; name: string }
const LAST_PROJECT = "agent-core-last-project";

const remembered = (): string | null => {
  try {
    return localStorage.getItem(LAST_PROJECT);
  } catch {
    return null;
  }
};

export function NewTaskScreen({ projectId }: { projectId?: number }) {
  const projects = useApi<Project[]>("/projects");
  return (
    <>
      <a className="back" href="#/tasks">‹ חזרה</a>
      <h2>משימה חדשה</h2>
      <State q={projects}>
        {(list) => (list.length === 0
          ? <div className="card"><strong>אין פרויקטים רשומים</strong><span className="muted small">רשום פרויקט במחשב עם <bdi>npm run project:add</bdi> ואז חזור לכאן.</span></div>
          : <Form projects={list} initial={projectId} />)}
      </State>
    </>
  );
}

function Form({ projects, initial }: { projects: Project[]; initial?: number }) {
  const first = String(projects.find((p) => p.id === initial)?.id ?? projects.find((p) => String(p.id) === remembered())?.id ?? projects[0]!.id);
  const [projectId, setProjectId] = useState(first);
  const [description, setDescription] = useState("");
  const [flagged, setFlagged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(LAST_PROJECT, projectId);
    } catch {
      // storage unavailable: the choice is simply not remembered
    }
  }, [projectId]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const task = await api<{ id: number }>("/tasks", { method: "POST", body: { project_id: Number(projectId), description: description.trim(), flagged } });
      window.location.hash = `#/tasks/${task.id}`;
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <form className="stack" onSubmit={submit}>
      <fieldset className="card" style={{ margin: 0 }}>
        <legend className="muted small">באיזה פרויקט?</legend>
        <div className="choices">
          {projects.map((p) => (
            <label key={p.id} className="choice">
              <input type="radio" name="project" value={p.id} checked={projectId === String(p.id)} onChange={() => setProjectId(String(p.id))} />
              {p.name}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="card">
        <label htmlFor="desc">מה לבצע? השורה הראשונה תהיה הכותרת</label>
        <textarea id="desc" rows={6} value={description} onChange={(e) => setDescription(e.target.value)} placeholder={"למשל:\nלבנות עמוד נחיתה לגיג של אוטומציית לידים"} required autoFocus />
        <label className="choice">
          <input type="checkbox" checked={flagged} onChange={(e) => setFlagged(e.target.checked)} />
          <span>משימה רגישה או מורכבת (תרוץ על המודל החזק, צורכת יותר)</span>
        </label>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <button className="primary" disabled={busy || description.trim() === ""}>{busy ? "יוצר…" : "התחל משימה"}</button>
    </form>
  );
}
