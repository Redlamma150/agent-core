import { useEffect, useState, type FormEvent } from "react";
import { useApi } from "../hooks";
import { api, uploadFile } from "../lib/api";
import { errorText, State } from "./common";
import { FilePicker } from "./media";

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
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [partial, setPartial] = useState<{ id: number; failed: string[] } | null>(null);

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
      // Created on hold, files uploaded, then started: the agent sees the files from its very first step.
      const task = await api<{ id: number }>("/tasks", { method: "POST", body: { project_id: Number(projectId), description: description.trim(), flagged, hold: files.length > 0 } });
      if (files.length > 0) {
        const failed: string[] = [];
        for (const f of files) await uploadFile(task.id, f).catch(() => failed.push(f.name));
        await api(`/tasks/${task.id}/start`, { method: "POST", body: {} });
        if (failed.length > 0) {
          setPartial({ id: task.id, failed });
          setBusy(false);
          return;
        }
      }
      window.location.hash = `#/tasks/${task.id}`;
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  if (partial) {
    return (
      <div className="callout need">
        <strong>המשימה התחילה, אבל לא כל הקבצים עלו</strong>
        <span className="small">לא הועלו: <bdi>{partial.failed.join(", ")}</bdi>. אפשר להוסיף אותם במסך המשימה.</span>
        <a className="pill" href={`#/tasks/${partial.id}`}>למשימה ›</a>
      </div>
    );
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
        <FilePicker files={files} onChange={setFiles} />
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
