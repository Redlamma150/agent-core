import { useEffect, useState } from "react";
import { useApi, useConnected } from "../hooks";
import { clockTime, type Quota } from "../lib/format";
import { api, uploadFile } from "../lib/api";
import { Icon, Segmented, Toggle } from "../ui";
import { errorText, State } from "./common";
import { clock, useVoice, useVoiceAvailable } from "../lib/voice";
import { useUndo } from "../undo";
import { AttachmentChips, fileProblem, MAX_FILES, MediaButtons } from "./media";

interface Project { id: number; name: string }
const LAST_PROJECT = "agent-core-last-project";

/** Starting points that fill the text field. The owner edits them before sending. */
const TEMPLATES = [
  { label: "תיקון באג", text: "לתקן באג: \n\nמה קורה היום:\nמה אמור לקרות:" },
  { label: "שינוי עיצוב", text: "לשנות את העיצוב של: \n\nמה לשנות:" },
  { label: "תכונה חדשה", text: "להוסיף תכונה: \n\nמה היא צריכה לעשות:" },
  { label: "בדיקות", text: "להוסיף בדיקות ל: " },
];

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
      <header className="top">
        <h1 className="h1s">משימה חדשה</h1>
        <a className="iconbtn" href="#/tasks" aria-label="סגירה"><Icon name="close" size={18} width={2.4} /></a>
      </header>
      <State q={projects} skeletons={3}>
        {(list) => (list.length === 0
          ? <div className="body"><div className="card"><div className="ttl">אין פרויקטים רשומים</div><div className="muted">אפשר להוסיף פרויקט ממסך הפרויקטים כשהאפליקציה פתוחה מהמחשב.</div><a className="btn" href="#/projects">לפרויקטים</a></div></div>
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
  const [reviewPlan, setReviewPlan] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [fileErrors, setFileErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [when, setWhen] = useState<"now" | "night" | "quota">("now");
  const [needText, setNeedText] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [partial, setPartial] = useState<{ id: number; failed: string[] } | null>(null);
  const connected = useConnected();
  const { notify } = useUndo();
  const voiceAvailable = useVoiceAvailable();
  const voice = useVoice((text) => { setDescription((d) => (d.trim() ? `${d.trimEnd()}\n${text}` : text)); setNeedText(false); }, notify);
  const nightHour = useApi<{ night_hour: number }>("/settings").data?.night_hour ?? 2;
  const quotaReset = useApi<{ quota: Quota | null }>("/usage").data?.quota?.five_hour?.resets_at ?? null;

  useEffect(() => {
    try {
      localStorage.setItem(LAST_PROJECT, projectId);
    } catch {
      // storage unavailable: the choice is simply not remembered
    }
  }, [projectId]);

  function addFiles(picked: File[]) {
    const bad: string[] = [];
    const next = [...files];
    for (const f of picked) {
      const problem = fileProblem(f);
      if (problem) bad.push(problem);
      else if (next.length >= MAX_FILES) bad.push(`אפשר עד ${MAX_FILES} קבצים`);
      else next.push(f);
    }
    setFileErrors(bad);
    setFiles(next);
  }

  async function submit() {
    // Files can carry the whole request, so the text is only required when there are none.
    if (description.trim() === "" && files.length === 0) return setNeedText(true);
    setBusy(true);
    setError(null);
    try {
      const text = description.trim() || "בצע לפי הקבצים המצורפים.";
      // Created on hold, files uploaded, then started: the agent sees the files from its very first step.
      const task = await api<{ id: number }>("/tasks", { method: "POST", body: { project_id: Number(projectId), description: text, flagged, hold: files.length > 0, when, review_plan: reviewPlan } });
      if (files.length > 0) {
        const failed: string[] = [];
        for (const f of files) await uploadFile(task.id, f).catch(() => failed.push(f.name));
        if (!(when === "night" || (when === "quota" && quotaReset !== null))) await api(`/tasks/${task.id}/start`, { method: "POST", body: {} }); // a scheduled task waits for its time
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
      <div className="body">
        <div className="card strong">
          <div className="ttl">המשימה התחילה, אבל לא כל הקבצים עלו</div>
          <div className="muted">לא הועלו: <bdi>{partial.failed.join(", ")}</bdi>. אפשר להוסיף אותם בגלריה של המשימה.</div>
          <a className="btn pri" href={`#/tasks/${partial.id}`}>למשימה</a>
        </div>
      </div>
    );
  }
  return (
    <>
      <div className="body has-bar one">
        <div className="group">
          <span className="label">פרויקט</span>
          <div className="row wrap">
            {projects.map((p) => (
              <button key={p.id} type="button" className="chip" aria-pressed={projectId === String(p.id)} onClick={() => setProjectId(String(p.id))}><span className="mono">{p.name}</span></button>
            ))}
          </div>
        </div>

        <div className="group">
          <label className="label" htmlFor="nt-text">מה לבצע</label>
          <textarea id="nt-text" className="field" style={{ height: 120 }} placeholder="השורה הראשונה תהיה הכותרת" value={description} onChange={(e) => { setDescription(e.target.value); setNeedText(false); }} />
          {needText && <span className="err" role="alert">כתוב מה לבצע, או צרף קובץ</span>}
          <div className="row wrap">
            <span className="muted">תבניות:</span>
            {TEMPLATES.map((t) => <button key={t.label} type="button" className="chip" onClick={() => { setDescription(t.text); setNeedText(false); }}>{t.label}</button>)}
          </div>
        </div>

        <div className="group">
          <span className="label">מדיה</span>
          <MediaButtons onPick={addFiles} disabled={files.length >= MAX_FILES} voice={{ available: voiceAvailable, state: voice.state, onToggle: voice.toggle }} />
          {voice.state === "recording" && <span className="rec" role="status">מקליט {clock(voice.seconds)}</span>}
          <AttachmentChips files={files} onRemove={(i) => setFiles(files.filter((_, j) => j !== i))} />
          {fileErrors.map((e) => <span key={e} className="err" role="alert">{e}</span>)}
          <span className="muted">הסוכן רואה את התמונות ואת ה-PDF. הקלטה הופכת לטקסט בשדה "מה לבצע", והתמלול רץ על המחשב שלך.</span>
        </div>

        <div className="group">
          <span className="label">מי יטפל</span>
          <Segmented label="מי יטפל" value="auto" onChange={() => undefined} options={[{ value: "auto", label: "אוטומטי" }, { value: "claude", label: "Claude", disabled: true }]} />
          <span className="muted">המערכת בוחרת לבד. כרגע הכול רץ על Claude, ובחירה ידנית של ספק תגיע בהמשך.</span>
        </div>

        <div className="group">
          <span className="label">מתי</span>
          <Segmented<"now" | "night" | "quota"> label="מתי" value={when} onChange={setWhen} options={[{ value: "now", label: "עכשיו" }, { value: "night", label: "הלילה" }, { value: "quota", label: "כשהמכסה מתחדשת" }]} />
          {when === "night" && <span className="muted">המשימה תתחיל ב-{String(nightHour).padStart(2, "0")}:00 והמחשב צריך להיות דלוק. אפשר להתחיל אותה קודם מהמסך שלה.</span>}
          {when === "quota" && (
            <span className="muted">{quotaReset ? `החלון של המנוי מתחדש ב-${clockTime(quotaReset)}. המשימה תתחיל אחריו.` : "עוד לא ידוע מתי המכסה מתחדשת (זה נלמד אחרי שסוכן רץ), ולכן המשימה תתחיל עכשיו."}</span>
          )}
        </div>

        <div className="card" style={{ gap: 14 }}>
          <Toggle label="משימה רגישה" sub="תרוץ על המודל החזק, צורכת יותר" checked={flagged} onChange={() => setFlagged(!flagged)} />
          <Toggle label="הראה לי את התוכנית לפני הבנייה" sub="המתכנן יציג תוכנית, והבונה יתחיל רק אחרי שתאשר אותה" checked={reviewPlan} onChange={() => setReviewPlan(!reviewPlan)} />
        </div>
        {error && <span className="err" role="alert">{error}</span>}
      </div>
      <div className="bar-fixed">
        <button type="button" className="btn pri big" disabled={busy || !connected} onClick={submit}>{busy ? "שולח…" : "שלח לסוכנים"}</button>
      </div>
    </>
  );
}
