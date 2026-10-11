import { useState } from "react";
import { useApi } from "../hooks";
import { api } from "../lib/api";
import { formatDate, formatNumber, statusLabel } from "../lib/format";
import { errorText, State } from "./common";
import type { TaskRow } from "./Tasks";

const FINAL = new Set(["merged", "stopped"]);

export function TaskScreen({ id }: { id: number }) {
  const task = useApi<TaskRow>(`/tasks/${id}`);
  const [error, setError] = useState<string | null>(null);

  async function stop() {
    if (!window.confirm("לעצור את המשימה עכשיו?")) return;
    try {
      await api(`/tasks/${id}/stop`, { method: "POST", body: {} });
      task.reload();
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <>
      <a href="#/tasks" className="back">‹ חזרה למשימות</a>
      <State q={task}>
        {(t) => (
          <div className="card">
            <div className="row between">
              <h2>משימה #{t.id}</h2>
              <span className={`chip s-${t.status}`}>{statusLabel(t.status)}</span>
            </div>
            <p className="pre">{t.description}</p>
            <dl>
              <dt>פרויקט</dt><dd>#{t.project_id}</dd>
              <dt>ענף</dt><dd dir="ltr">{t.branch ?? "—"}</dd>
              <dt>טוקנים</dt><dd>{formatNumber(t.tokens_used)}</dd>
              <dt>נוצרה</dt><dd>{formatDate(t.created_at)}</dd>
              <dt>עודכנה</dt><dd>{formatDate(t.updated_at)}</dd>
            </dl>
            {error && <p className="error" role="alert">{error}</p>}
            {!FINAL.has(t.status) && <button className="danger" onClick={stop}>עצור משימה</button>}
          </div>
        )}
      </State>
    </>
  );
}
