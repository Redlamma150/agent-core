import { useEffect, useRef, useState, type DragEvent } from "react";
import { useApi } from "../hooks";
import { api, fetchBlobUrl, uploadFile } from "../lib/api";
import { errorText } from "./common";

export const ACCEPT = "image/png,image/jpeg,image/webp,image/gif,application/pdf,text/plain,text/markdown,text/csv";
const MAX_BYTES = 15 * 1024 * 1024;
export const MAX_FILES = 10;

export interface Attachment { id: number; name: string; mime: string; size: number }

/** Why a file cannot be attached, or null when it is fine. Checked on the phone so a bad file is caught before the upload. */
export function fileProblem(f: { type: string; size: number; name: string }): string | null {
  if (!ACCEPT.split(",").includes(f.type)) return `"${f.name}": סוג הקובץ לא נתמך (תמונות, PDF או טקסט)`;
  if (f.size > MAX_BYTES) return `"${f.name}": גדול מדי (עד 15MB)`;
  if (f.size === 0) return `"${f.name}": הקובץ ריק`;
  return null;
}

/** Small preview of an attached image; non-images show an icon. */
function Thumb({ file, url }: { file: { name: string; type: string }; url?: string }) {
  return file.type.startsWith("image/") && url
    ? <img className="thumb" src={url} alt={file.name} />
    : <span className="thumb file" aria-hidden="true">{file.type === "application/pdf" ? "PDF" : "TXT"}</span>;
}

/** Choose or drop files before the task exists. The parent uploads them once the task is created. */
export function FilePicker({ files, onChange }: { files: File[]; onChange: (f: File[]) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [over, setOver] = useState(false);
  const urls = useRef(new Map<File, string>());

  useEffect(() => {
    const map = urls.current;
    return () => map.forEach((u) => URL.revokeObjectURL(u));
  }, []);
  const urlOf = (f: File) => {
    if (!f.type.startsWith("image/")) return undefined;
    if (!urls.current.has(f)) urls.current.set(f, URL.createObjectURL(f));
    return urls.current.get(f);
  };

  function add(list: FileList | null) {
    if (!list) return;
    const bad: string[] = [];
    const next = [...files];
    for (const f of Array.from(list)) {
      const problem = fileProblem(f);
      if (problem) bad.push(problem);
      else if (next.length >= MAX_FILES) bad.push(`אפשר עד ${MAX_FILES} קבצים`);
      else next.push(f);
    }
    setProblems(bad);
    onChange(next);
  }
  const drop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    add(e.dataTransfer.files);
  };

  return (
    <div className={`dropzone ${over ? "over" : ""}`} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={drop}>
      <input ref={input} type="file" accept={ACCEPT} multiple hidden onChange={(e) => { add(e.target.files); e.target.value = ""; }} />
      <button type="button" onClick={() => input.current?.click()}>📎 צרף תמונות או קבצים</button>
      <span className="muted small">אפשר גם לגרור לכאן. הסוכן רואה את התמונות ואת ה-PDF.</span>
      {files.length > 0 && (
        <ul className="attachments">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`}>
              <Thumb file={f} url={urlOf(f)} />
              <span className="name"><bdi>{f.name}</bdi></span>
              <button type="button" className="quiet" aria-label={`הסר ${f.name}`} onClick={() => onChange(files.filter((_, j) => j !== i))}>✕</button>
            </li>
          ))}
        </ul>
      )}
      {problems.map((p) => <p key={p} className="error" role="alert">{p}</p>)}
    </div>
  );
}

/** The files already attached to a task, with the option to add more or remove one. */
export function TaskAttachments({ taskId, editable }: { taskId: number; editable: boolean }) {
  const list = useApi<Attachment[]>(`/tasks/${taskId}/media`);
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [urls, setUrls] = useState<Record<number, string>>({});

  useEffect(() => {
    let live = true;
    for (const a of list.data ?? []) {
      if (a.mime.startsWith("image/") && !urls[a.id]) {
        fetchBlobUrl(`/tasks/${taskId}/media/${a.id}`).then((u) => live && setUrls((m) => ({ ...m, [a.id]: u }))).catch(() => undefined);
      }
    }
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.data, taskId]);
  useEffect(() => () => Object.values(urls).forEach((u) => URL.revokeObjectURL(u)), []); // eslint-disable-line react-hooks/exhaustive-deps

  async function add(files: FileList | null) {
    if (!files) return;
    setBusy(true);
    setError(null);
    for (const f of Array.from(files)) {
      const problem = fileProblem(f);
      if (problem) { setError(problem); continue; }
      try { await uploadFile(taskId, f); } catch (err) { setError(errorText(err)); }
    }
    setBusy(false);
    list.reload();
  }
  async function remove(id: number) {
    try { await api(`/tasks/${taskId}/media/${id}`, { method: "DELETE" }); list.reload(); } catch (err) { setError(errorText(err)); }
  }

  const items = list.data ?? [];
  if (items.length === 0 && !editable) return null;
  return (
    <div className="card">
      <div className="row between"><h3>קבצים מצורפים</h3>{editable && (
        <>
          <input ref={input} type="file" accept={ACCEPT} multiple hidden onChange={(e) => { void add(e.target.files); e.target.value = ""; }} />
          <button type="button" disabled={busy} onClick={() => input.current?.click()}>{busy ? "מעלה…" : "📎 הוסף"}</button>
        </>
      )}</div>
      {items.length === 0 && <p className="muted small">עדיין לא צורפו קבצים.</p>}
      <ul className="attachments">
        {items.map((a) => (
          <li key={a.id}>
            <Thumb file={{ name: a.name, type: a.mime }} url={urls[a.id]} />
            <span className="name"><bdi>{a.name}</bdi></span>
            {editable && <button type="button" className="quiet" aria-label={`הסר ${a.name}`} onClick={() => remove(a.id)}>✕</button>}
          </li>
        ))}
      </ul>
      {editable && items.length > 0 && <p className="muted small">קבצים חדשים יגיעו לסוכן בהרצה הבאה שלו (למשל כשממשיכים משימה עצורה).</p>}
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}
