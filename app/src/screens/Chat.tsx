import { useState, type FormEvent } from "react";
import { api } from "../lib/api";
import { errorText } from "./common";

interface Line {
  from: "me" | "system";
  text: string;
}

export function ChatScreen() {
  const [text, setText] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [busy, setBusy] = useState(false);

  async function send(e: FormEvent) {
    e.preventDefault();
    const message = text.trim();
    if (!message) return;
    setText("");
    setBusy(true);
    setLines((l) => [...l, { from: "me", text: message }]);
    try {
      const res = await api<{ reply?: string }>("/chat", { method: "POST", body: { text: message } });
      setLines((l) => [...l, { from: "system", text: res?.reply ?? "התקבל." }]);
    } catch (err) {
      setLines((l) => [...l, { from: "system", text: errorText(err) }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h2>שיחה עם המתפעל</h2>
      <ul className="chat" aria-live="polite">
        {lines.map((l, i) => (
          <li key={i} className={l.from}>{l.text}</li>
        ))}
      </ul>
      <form className="chatform" onSubmit={send}>
        <label htmlFor="msg" className="sr-only">הודעה</label>
        <input id="msg" value={text} onChange={(e) => setText(e.target.value)} placeholder="כתוב הודעה…" />
        <button className="primary" disabled={busy || text.trim() === ""}>שלח</button>
      </form>
    </>
  );
}
