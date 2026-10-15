import { useApi } from "../hooks";
import type { TaskRow } from "../lib/format";
import { State } from "./common";

export function ProjectsScreen() {
  const projects = useApi<{ id: number; name: string }[]>("/projects");
  const tasks = useApi<TaskRow[]>("/tasks?view=active");
  return (
    <>
      <h2>פרויקטים</h2>
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
                  <a className="pill" href={`#/new?project=${p.id}`}>+ משימה חדשה בפרויקט</a>
                </li>
              );
            })}
          </ul>
        )}
      </State>
    </>
  );
}
