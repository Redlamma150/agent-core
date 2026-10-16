import { useEffect, useRef, useState } from "react";
import { useConnected } from "../hooks";
import { api } from "../lib/api";
import { Icon, TopBar } from "../ui";
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
const QUICK = ["מה המצב עכשיו?", "מה מחכה לאישור שלי?", "סכם לי את היום", "כמה טוקנים נצרכו היום?"];

const load = (): Line[] => {
  try {
    return JSON.parse(sessionStorage.getItem(KEY) ?? "[]") as Line[];
  } catch {
    return [];
  }
};

/** `ask` comes from a link on another screen ("פרט לי בצ'אט"): it is sent once, then removed from the address. */
export function ChatScreen({ ask }: { ask?: string }) {
  const [text, setText] = useState("");
  const [lines, setLines] = useState<Line[]>(load);
  const [busy, setBusy] = useState(false);
  const connected = useConnected();
  const end = useRef<HTMLDivElement>(null);
  const asked = useRef(false);

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

  useEffect(() => {
    if (!ask || asked.current) return;
    asked.current = true;
    window.history.replaceState(null, "", `${window.location.pathname}#/chat`);
    void send(ask);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ask]);

  return (
    <>
      <TopBar title="המתפעל" sub="מבין עברית חופשית, ומבצע אחרי אישור" />
      <div className="body has-chat" style={{ gap: 10 }}>
        {lines.length === 0 && <div className="msg op">שלום רפאל. אפשר לשאול מה קורה במשימות, באישורים ובצריכה, ולבקש להתחיל, לעצור או להמשיך משימה. אישור ומיזוג נשארים אצלך, בכפתור.</div>}
        {lines.map((l, i) => (
          <div key={i} className={`msg ${l.from === "me" ? "me" : "op"}`}>
            <span className="pre">{l.text}</span>
            {l.actions?.map((a) => (
              <a key={`${a.type}-${a.task_id}`} className="btn sm" style={{ alignSelf: "flex-start" }} href={`#/tasks/${a.task_id}`}>{ACTION_LABEL[a.type]} #{a.task_id}: פתח</a>
            ))}
          </div>
        ))}
        {busy && <div className="msg op muted" role="status">כותב…</div>}
        {lines.length > 0 && !busy && <button type="button" className="btn ghost sm" style={{ alignSelf: "center" }} onClick={() => setLines([])}>נקה שיחה</button>}
        <div ref={end} aria-hidden="true" style={{ height: 1 }} />
      </div>
      <div className="chat-bar">
        <div className="row quick">
          {QUICK.map((q) => <button key={q} type="button" className="chip" disabled={busy || !connected} onClick={() => void send(q)}>{q}</button>)}
        </div>
        <form className="row" style={{ gap: 6 }} onSubmit={(e) => { e.preventDefault(); void send(text); }}>
          <button type="button" className="iconbtn soon" disabled aria-label="הקלטה, בקרוב"><Icon name="mic" /></button>
          <input className="field" aria-label="הודעה למתפעל" placeholder="כתוב הודעה…" autoComplete="off" value={text} onChange={(e) => setText(e.target.value)} />
          <button type="submit" className="iconbtn pri" aria-label="שלח" disabled={busy || !connected || text.trim() === ""}><span style={{ display: "inline-flex", transform: "scaleX(-1)" }}><Icon name="send" size={18} color="#fff" width={2.2} /></span></button>
        </form>
      </div>
    </>
  );
}
