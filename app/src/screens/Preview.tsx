import { useEffect, useState } from "react";
import { useApi, useConnected } from "../hooks";
import { api, fetchBlobUrl } from "../lib/api";
import { clockTime } from "../lib/format";
import { useUndo } from "../undo";
import { errorText } from "./common";
import { Segmented } from "../ui";
import type { Attachment } from "./media";

type Device = "phone" | "desktop";
type Moment = "before" | "after";

interface Shot extends Attachment { kind?: "upload" | "screenshot" }

/** The screenshots the core took after the build: phone or desktop, before or after the change. */
export function useShots(taskId: number): { shots: Map<string, Shot>; loading: boolean } {
  const list = useApi<Shot[]>(`/tasks/${taskId}/media`);
  const shots = new Map<string, Shot>();
  for (const a of list.data ?? []) if (a.kind === "screenshot") shots.set(a.name.replace(/\.png$/, ""), a);
  return { shots, loading: list.loading && list.data === null };
}

export function PreviewFrame({ taskId, shots }: { taskId: number; shots: Map<string, Shot> }) {
  const [device, setDevice] = useState<Device>("phone");
  const [moment, setMoment] = useState<Moment>("after");
  const hasBefore = shots.has(`before-${device}`);
  const shown = hasBefore || moment === "after" ? moment : "after";
  const shot = shots.get(`${shown}-${device}`);
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!shot) return setUrl(null);
    let live = true;
    let made: string | null = null;
    fetchBlobUrl(`/tasks/${taskId}/media/${shot.id}`).then((u) => { made = u; if (live) setUrl(u); else URL.revokeObjectURL(u); }).catch(() => live && setUrl(null));
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [taskId, shot?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="group">
      <div className="row">
        <div className="grow"><Segmented<Device> label="גודל מסך" value={device} onChange={setDevice} options={[{ value: "phone", label: "נייד" }, { value: "desktop", label: "מחשב" }]} /></div>
        <div className="grow"><Segmented<Moment> label="לפני או אחרי" value={shown} onChange={setMoment} options={[{ value: "before", label: "לפני", disabled: !hasBefore }, { value: "after", label: "אחרי" }]} /></div>
      </div>
      <div className="frame-wrap">
        <div className={`frame ${device}`}>
          {url ? <img src={url} alt={`צילום ${shown === "before" ? "לפני" : "אחרי"} בגודל ${device === "phone" ? "נייד" : "מחשב"}`} /> : <div className="frame-empty muted">{shot ? "טוען…" : "אין צילום בגודל הזה"}</div>}
        </div>
      </div>
      {!hasBefore && <div className="muted">אין מצב קודם להשוואה: העמוד הזה חדש.</div>}
    </div>
  );
}

interface LiveInfo { running: boolean; kind?: "static" | "dev"; urls?: string[]; expires_at?: string }

/** The address to open from where the app is being used: this computer's own, or the Tailscale one from the phone. */
function pickUrl(urls: string[]): string {
  const here = window.location.hostname;
  const local = here === "localhost" || here === "127.0.0.1";
  return urls.find((u) => (local ? /\/\/127\.0\.0\.1:/.test(u) : !/\/\/127\.0\.0\.1:/.test(u))) ?? urls[0] ?? "";
}

/**
 * A test environment for work that is not merged yet: the core opens the task's worktree on its own port, and the owner tries it
 * before approving. It is private to this owner (secret link, tailnet only) and closes by itself when not used.
 */
export function LiveEnvironment({ taskId }: { taskId: number }) {
  const state = useApi<LiveInfo>(`/tasks/${taskId}/preview`);
  const { notify } = useUndo();
  const connected = useConnected();
  const [busy, setBusy] = useState(false);

  async function change(method: "POST" | "DELETE") {
    setBusy(true);
    try {
      await api(`/tasks/${taskId}/preview`, { method, body: method === "POST" ? {} : undefined });
      state.reload();
    } catch (err) {
      notify(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const info = state.data;
  const url = info?.running && info.urls ? pickUrl(info.urls) : "";
  return (
    <div className="card">
      <div className="row between"><h2 className="h2">סביבת בדיקה</h2>{info?.running && <span className="live">פעילה</span>}</div>
      {!info?.running ? (
        <>
          <p className="txt">אפשר לפתוח את העבודה הזאת ולנסות אותה בעצמך לפני שמאשרים, מהמחשב או מהנייד.</p>
          <button type="button" className="btn" disabled={busy || !connected} onClick={() => void change("POST")}>{busy ? "מפעיל…" : "הפעל סביבת בדיקה"}</button>
        </>
      ) : (
        <>
          <a className="btn pri" href={url} target="_blank" rel="noopener noreferrer">פתח את הסביבה</a>
          <p className="muted">
            {info.kind === "dev" ? "האתר רץ עם הפקודה שהוגדרה לפרויקט." : "העמוד מוגש מהעבודה של המשימה."} הקישור פרטי, פתוח רק ברשת שלך, ונסגר לבד אחרי חצי שעה בלי שימוש (עד {info.expires_at ? clockTime(info.expires_at) : ""}).
          </p>
          <button type="button" className="btn dan sm" disabled={busy} onClick={() => void change("DELETE")}>סגור את הסביבה</button>
        </>
      )}
    </div>
  );
}
