import { useEffect, useRef, useState } from "react";
import { useConnected } from "../hooks";
import { api, uploadChatFile } from "../lib/api";
import { clock, useVoice, useVoiceAvailable } from "../lib/voice";
import { Icon, TopBar } from "../ui";
import { useUndo } from "../undo";
import { errorText } from "./common";
import { AttachmentChips, fileProblem, MAX_CHAT_FILES, MediaButtons } from "./media";

interface Action { type: "created" | "stopped" | "continued"; task_id: number }
interface Line {
  from: "me" | "system";
  text: string;
  actions?: Action[];
  /** Names of the files that went with a message of the owner. */
  files?: string[];
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
  const [files, setFiles] = useState<File[]>([]);
  const [attaching, setAttaching] = useState(false);
  const { notify } = useUndo();
  const voiceAvailable = useVoiceAvailable();
  const voice = useVoice((spoken) => setText((t) => (t.trim() ? `${t.trimEnd()} ${spoken}` : spoken)), notify);

  useEffect(() => {
    try {
      sessionStorage.setItem(KEY, JSON.stringify(lines.slice(-40)));
    } catch {
      // storage unavailable: the conversation just is not kept after leaving the screen
    }
    end.current?.scrollIntoView({ block: "end" });
  }, [lines, busy]);

  function addFiles(picked: File[]) {
    const next = [...files];
    for (const f of picked) {
      const problem = fileProblem(f);
      if (problem) notify(problem);
      else if (next.length >= MAX_CHAT_FILES) notify(`אפשר לצרף עד ${MAX_CHAT_FILES} קבצים להודעה.`);
      else next.push(f);
    }
    setFiles(next);
  }

  async function send(message: string) {
    // Files can be the whole message ("what is this?"), so the text may be empty when something is attached.
    const clean = message.trim() || (files.length > 0 ? "צירפתי קבצים." : "");
    if (!clean || busy) return;
    const sending = files;
    setText("");
    setFiles([]);
    setAttaching(false);
    setBusy(true);
    const history = lines.slice(-HISTORY).map(({ from, text: t }) => ({ from, text: t }));
    setLines((l) => [...l, { from: "me", text: clean, ...(sending.length > 0 ? { files: sending.map((f) => f.name) } : {}) }]);
    try {
      const media: number[] = [];
      for (const f of sending) media.push(await uploadChatFile(f));
      const res = await api<{ reply: string; actions: Action[] }>("/chat", { method: "POST", body: { text: clean, history, ...(media.length > 0 ? { media } : {}) } });
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
            {l.files && <span style={{ fontSize: 13, opacity: 0.9 }}>צורפו: <bdi>{l.files.join(", ")}</bdi></span>}
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
        {attaching && <MediaButtons onPick={addFiles} disabled={files.length >= MAX_CHAT_FILES} />}
        <AttachmentChips files={files} onRemove={(i) => setFiles(files.filter((_, j) => j !== i))} />
        <form className="row" style={{ gap: 6 }} onSubmit={(e) => { e.preventDefault(); void send(text); }}>
          <button
            type="button"
            className={`iconbtn ${voice.state === "recording" ? "recording" : ""} ${voiceAvailable ? "" : "soon"}`}
            disabled={!voiceAvailable || voice.state === "transcribing"}
            aria-pressed={voice.state === "recording"}
            aria-label={!voiceAvailable ? "הקלטה: התמלול לא מותקן במחשב" : voice.state === "recording" ? "עצור הקלטה" : voice.state === "transcribing" ? "מתמלל" : "הקלט"}
            onClick={voice.toggle}
          ><Icon name="mic" /></button>
          <input className="field" aria-label="הודעה למתפעל" placeholder={voice.state === "recording" ? `מקליט ${clock(voice.seconds)}…` : voice.state === "transcribing" ? "מתמלל…" : "כתוב הודעה…"} autoComplete="off" value={text} onChange={(e) => setText(e.target.value)} />
          <button type="button" className="iconbtn" aria-label="צרף תמונה או קובץ" aria-expanded={attaching} disabled={busy || !connected} onClick={() => setAttaching((a) => !a)}><Icon name="file" /></button>
          <button type="submit" className="iconbtn pri" aria-label="שלח" disabled={busy || !connected || (text.trim() === "" && files.length === 0)}><span style={{ display: "inline-flex", transform: "scaleX(-1)" }}><Icon name="send" size={18} color="#fff" width={2.2} /></span></button>
        </form>
      </div>
    </>
  );
}
