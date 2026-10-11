import { useState } from "react";
import { useApi } from "../hooks";
import { api } from "../lib/api";
import { formatDate } from "../lib/format";
import { errorText, State } from "./common";

interface ApprovalRow {
  id: number;
  task_id: number;
  request_text: string;
  reminders_sent: number;
  created_at: string;
}

export function ApprovalsScreen() {
  const approvals = useApi<ApprovalRow[]>("/approvals");
  return (
    <State q={approvals}>
      {(rows) =>
        rows.length === 0 ? (
          <p className="muted">אין בקשות אישור ממתינות.</p>
        ) : (
          <ul className="list">
            {rows.map((a) => (
              <li key={a.id}>
                <ApprovalCard a={a} onDone={approvals.reload} />
              </li>
            ))}
          </ul>
        )
      }
    </State>
  );
}

function ApprovalCard({ a, onDone }: { a: ApprovalRow; onDone: () => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(decision: "approve" | "reject") {
    setBusy(true);
    setError(null);
    try {
      await api(`/approvals/${a.id}`, { method: "POST", body: { decision, note: note.trim() || undefined } });
      onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <div className="row between">
        <a href={`#/tasks/${a.task_id}`}><strong>משימה #{a.task_id}</strong></a>
        <small className="muted">{formatDate(a.created_at)}</small>
      </div>
      <p className="pre">{a.request_text}</p>
      {a.reminders_sent > 0 && <small className="muted">נשלחו {a.reminders_sent} תזכורות</small>}
      <label htmlFor={`note-${a.id}`}>הערה (לדחייה)</label>
      <textarea id={`note-${a.id}`} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
      {error && <p className="error" role="alert">{error}</p>}
      <div className="row">
        <button className="primary" disabled={busy} onClick={() => decide("approve")}>אשר</button>
        <button className="danger" disabled={busy} onClick={() => decide("reject")}>דחה</button>
      </div>
    </div>
  );
}
