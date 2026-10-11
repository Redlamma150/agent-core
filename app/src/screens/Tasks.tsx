import { useState, type FormEvent } from "react";
import { useApi } from "../hooks";
import { api } from "../lib/api";
import { formatDate, statusLabel } from "../lib/format";
import { errorText, State } from "./common";

export interface TaskRow {
  id: number;
  project_id: number;
  description: string;
  status: string;
  branch: string | null;
  tokens_used: number;
  created_at: string;
  updated_at: string;
}

export function TasksScreen() {
  const tasks = useApi<TaskRow[]>("/tasks");
  const [description, setDescription] = useState("");
  const [projectId, setProjectId] = useState("1");
  const [error, setError] = useState<string | null>(null);

  async function create(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api("/tasks", { method: "POST", body: { project_id: Number(projectId), description } });
      setDescription("");
      tasks.reload();
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <>
      <form className="card" onSubmit={create}>
        <label htmlFor="desc">משימה חדשה</label>
        <textarea id="desc" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} required />
        <div className="row">
          <label htmlFor="proj">מספר פרויקט</label>
          <input id="proj" type="number" min={1} inputMode="numeric" value={projectId} onChange={(e) => setProjectId(e.target.value)} required />
        </div>
        {error && <p className="error" role="alert">{error}</p>}
        <button className="primary" disabled={description.trim() === ""}>צור משימה</button>
      </form>
      <State q={tasks}>
        {(rows) =>
          rows.length === 0 ? (
            <p className="muted">אין משימות עדיין.</p>
          ) : (
            <ul className="list">
              {rows.map((t) => (
                <li key={t.id}>
                  <a className="card item" href={`#/tasks/${t.id}`}>
                    <div className="row between">
                      <strong>#{t.id}</strong>
                      <span className={`chip s-${t.status}`}>{statusLabel(t.status)}</span>
                    </div>
                    <p className="clamp">{t.description}</p>
                    <small className="muted">{formatDate(t.updated_at)}</small>
                  </a>
                </li>
              ))}
            </ul>
          )
        }
      </State>
    </>
  );
}
