import { useEffect, useState } from "react";
import { useApi } from "../hooks";
import { fetchBlobUrl } from "../lib/api";
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
