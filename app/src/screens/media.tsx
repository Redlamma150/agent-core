import { useEffect, useRef, useState } from "react";
import { useApi, useConnected } from "../hooks";
import { api, fetchBlobUrl, uploadFile } from "../lib/api";
import { Icon, Soon } from "../ui";
import { useUndo } from "../undo";
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

const isHeic = (f: File) => /^image\/hei[cf]$/i.test(f.type) || /\.hei[cf]$/i.test(f.name);

/** iPhone photos can be HEIC, which the core rejects. They are converted to JPEG on the phone before upload. */
export async function prepareFile(f: File): Promise<File> {
  if (!isHeic(f)) return f;
  try {
    const bitmap = await createImageBitmap(f);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
    if (!blob) return f;
    return new File([blob], f.name.replace(/\.hei[cf]$/i, "") + ".jpg", { type: "image/jpeg" });
  } catch {
    return f; // not convertible here: the type check reports it
  }
}

/** Small preview of an attached image; other files show their kind. */
function Thumb({ file, url }: { file: { name: string; type: string }; url?: string }) {
  return file.type.startsWith("image/") && url
    ? <img className="thumb" src={url} alt={file.name} />
    : <span className="thumb file" aria-hidden="true">{file.type === "application/pdf" ? "PDF" : "TXT"}</span>;
}

/** Camera, image and file buttons. Recording waits for transcription in the core. */
export function MediaButtons({ onPick, disabled }: { onPick: (files: File[]) => void; disabled?: boolean }) {
  const camera = useRef<HTMLInputElement>(null);
  const image = useRef<HTMLInputElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const take = async (list: FileList | null) => {
    if (list) onPick(await Promise.all(Array.from(list).map(prepareFile)));
  };
  const hidden = (ref: React.RefObject<HTMLInputElement | null>, accept: string, capture?: "environment") => (
    <input ref={ref} type="file" accept={accept} capture={capture} multiple={!capture} hidden onChange={(e) => { void take(e.target.files); e.target.value = ""; }} />
  );
  return (
    <div className="media-grid">
      {hidden(camera, "image/*", "environment")}
      {hidden(image, "image/*")}
      {hidden(file, ACCEPT)}
      <button type="button" className="btn" disabled={disabled} onClick={() => camera.current?.click()}><Icon name="camera" />מצלמה</button>
      <button type="button" className="btn" disabled={disabled} onClick={() => image.current?.click()}><Icon name="image" />תמונה</button>
      <button type="button" className="btn" disabled={disabled} onClick={() => file.current?.click()}><Icon name="file" />קובץ</button>
      <button type="button" className="btn soon" disabled aria-label="הקלטה, בקרוב"><Icon name="mic" />הקלטה</button>
    </div>
  );
}

/** Files chosen before the task exists. The parent uploads them once the task is created. */
export function AttachmentChips({ files, onRemove }: { files: File[]; onRemove: (i: number) => void }) {
  if (files.length === 0) return null;
  return (
    <div className="row wrap">
      {files.map((f, i) => (
        <span key={`${f.name}-${i}`} className="att">
          <span className="name"><bdi>{f.name}</bdi></span>
          <button type="button" aria-label={`הסר ${f.name}`} onClick={() => onRemove(i)}><Icon name="close" size={14} width={2.6} /></button>
        </span>
      ))}
    </div>
  );
}

/** Every file that came in with the task, as a grid. The owner can add a photo or remove a file. */
export function TaskGallery({ taskId, editable }: { taskId: number; editable: boolean }) {
  const list = useApi<Attachment[]>(`/tasks/${taskId}/media`);
  const { notify } = useUndo();
  const connected = useConnected();
  const input = useRef<HTMLInputElement>(null);
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

  async function add(picked: File[]) {
    setBusy(true);
    for (const f of picked) {
      const problem = fileProblem(f);
      if (problem) { notify(problem); continue; }
      try { await uploadFile(taskId, f); } catch (err) { notify(errorText(err)); }
    }
    setBusy(false);
    list.reload();
  }
  async function remove(id: number) {
    try { await api(`/tasks/${taskId}/media/${id}`, { method: "DELETE" }); list.reload(); } catch (err) { notify(errorText(err)); }
  }

  const items = list.data ?? [];
  return (
    <>
      <span className="muted">נכנס למשימה ויצא ממנה</span>
      {items.length === 0 && <div className="card center"><div className="muted">עדיין לא צורפו קבצים</div></div>}
      <div className="gal">
        {items.map((a) => (
          <div key={a.id} className="group" style={{ gap: 4 }}>
            <div className="th" role="img" aria-label={a.name} style={urls[a.id] ? { backgroundImage: `url(${urls[a.id]})` } : undefined}>
              {!urls[a.id] && <span className="muted" aria-hidden="true">{a.mime === "application/pdf" ? "PDF" : "TXT"}</span>}
              <span className="cap"><bdi>{a.name}</bdi></span>
            </div>
            {editable && <button type="button" className="btn ghost sm" aria-label={`הסר ${a.name}`} onClick={() => remove(a.id)}>הסר</button>}
          </div>
        ))}
      </div>
      {editable && (
        <>
          <input ref={input} type="file" accept="image/*,application/pdf,text/plain,text/markdown,text/csv" multiple hidden onChange={async (e) => { const picked = await Promise.all(Array.from(e.target.files ?? []).map(prepareFile)); e.target.value = ""; void add(picked); }} />
          <div className="row">
            <button type="button" className="btn grow" disabled={busy || !connected} onClick={() => input.current?.click()}>{busy ? "מעלה…" : "הוסף תמונה"}</button>
            <button type="button" className="btn grow soon" disabled>הקלט הערה</button>
          </div>
          <div className="row"><Soon>הקלטות</Soon></div>
          {items.length > 0 && <div className="muted">קבצים חדשים יגיעו לסוכן בהרצה הבאה שלו, למשל כשממשיכים משימה עצורה.</div>}
        </>
      )}
    </>
  );
}
