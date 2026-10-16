import { useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "../lib/api";
import { errorText } from "./common";

interface Action { type: "created" | "stopped" | "continued"; task_id: number }
interface Line {
  from: "me" | "system";
  text: string;
  actions?: Action[];
}

const KEY = "agent-core-chat";
const HISTORY = 10;
const ACTION_LABEL: Record<Action["type"], string> = { created: "נוצרה משימה", stopped: "נעצרה משימה", continued: "המשימה ממשיכה" };
const EXAMPLES = ["מה המצב עכשיו?", "מה מחכה לאישור שלי?", "כמה טוקנים נצרכו היום?"];

const load = (): Line[] => {
  try {
    return JSON.parse(sessionStorage.getItem(KEY) ?? "[]") as Line[];
  } catch {
    return [];
  }
};

export function ChatScreen() {
  const [text, setText] = useState("");
  const [lines, setLines] = useState<Line[]>(load);
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLLIElement>(null);

  useEffect(() => {
    try {
      sessionStorage.setItem(KEY, JSON.stringify(lines.slice(-40)));
    } catch {
      // storage unavailable: the conversation just is not kept after leaving the screen
    }
    end.current?.scrollIntoView({ block: "end" });
  }, [lines, busy]);

  async function send(message: string) {
    const clean = message.trim();
    if (!clean || busy) return;
    setText("");
    setBusy(true);
    const history = lines.slice(-HISTORY).map(({ from, text: t }) => ({ from, text: t }));
    setLines((l) => [...l, { from: "me", text: clean }]);
    try {
      const res = await api<{ reply: string; actions: Action[] }>("/chat", { method: "POST", body: { text: clean, history } });
      setLines((l) => [...l, { from: "system", text: res.reply, actions: res.actions }]);
    } catch (err) {
      setLines((l) => [...l, { from: "system", text: errorText(err) }]);
    } finally {
      setBusy(false);
    }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void send(text);
  };

  return (
    <>
      <div className="row between">
        <h2>שיחה עם המתפעל</h2>
        {lines.length > 0 && <button className="quiet" onClick={() => setLines([])}>נקה</button>}
      </div>
      {lines.length === 0 && (
        <div className="card flat">
          <strong>אפשר לשאול ולבקש בכתיבה חופשית</strong>
          <span className="muted small">המתפעל יודע מה קורה במשימות, באישורים ובצריכה, ויכול להתחיל, לעצור ולהמשיך משימות. אישור ומיזוג נשארים אצלך, בכפתור.</span>
          <div className="actions">
            {EXAMPLES.map((e) => <button key={e} onClick={() => void send(e)}>{e}</button>)}
          </div>
        </div>
      )}
      <ul className="chat" aria-live="polite">
        {lines.map((l, i) => (
          <li key={i} className={l.from}>
            <span className="pre">{l.text}</span>
            {l.actions?.map((a) => (
              <a key={`${a.type}-${a.task_id}`} className="pill" href={`#/tasks/${a.task_id}`}>{ACTION_LABEL[a.type]} #{a.task_id} ›</a>
            ))}
          </li>
        ))}
        {busy && <li className="system muted">המתפעל חושב…</li>}
        <li ref={end} aria-hidden="true" className="end" />
      </ul>
      <form className="chatform" onSubmit={submit}>
        <label htmlFor="msg" className="sr-only">הודעה</label>
        <input id="msg" value={text} onChange={(e) => setText(e.target.value)} placeholder="כתוב הודעה…" autoComplete="off" />
        <button className="primary" disabled={busy || text.trim() === ""}>שלח</button>
      </form>
    </>
  );
}
