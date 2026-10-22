import { useEffect, useRef, useState } from "react";
import { fetchBlobUrl } from "../lib/api";
import { Sheet } from "../ui";
import { useUndo } from "../undo";
import { prepareFile } from "./media";

const COLORS = [
  { name: "אדום", value: "#E5252A" },
  { name: "כחול", value: "#2F5BEA" },
  { name: "צהוב", value: "#F5B800" },
];
const MAX_SIDE = 1600; // keeps the picture a size the agents can read and the upload small

interface Stroke { color: string; width: number; points: [number, number][] }

/**
 * Draw on a screenshot with a finger or a mouse to show exactly what is wrong. The result is a new PNG named
 * annotated-*.png, which the agents are told is the owner's own marking. The original is never changed.
 */
export function AnnotatorSheet({ source, onDone, onClose }: { source: Blob; onDone: (file: File) => void; onClose: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const image = useRef<HTMLImageElement | null>(null);
  const strokes = useRef<Stroke[]>([]);
  const current = useRef<Stroke | null>(null);
  const [color, setColor] = useState(COLORS[0]!.value);
  const [ready, setReady] = useState(false);
  const [count, setCount] = useState(0); // re-renders the undo button
  const { notify } = useUndo();

  const redraw = () => {
    const c = canvas.current;
    const img = image.current;
    if (!c || !img) return;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(img, 0, 0, c.width, c.height);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const s of [...strokes.current, ...(current.current ? [current.current] : [])]) {
      ctx.strokeStyle = s.color;
      ctx.fillStyle = s.color;
      ctx.lineWidth = s.width;
      ctx.beginPath();
      const [first, ...rest] = s.points;
      if (!first) continue;
      ctx.moveTo(first[0], first[1]);
      if (rest.length === 0) ctx.arc(first[0], first[1], s.width / 2, 0, Math.PI * 2);
      for (const p of rest) ctx.lineTo(p[0], p[1]);
      ctx.stroke();
    }
  };

  useEffect(() => {
    let live = true;
    const url = URL.createObjectURL(source);
    const img = new Image();
    img.onload = () => {
      if (!live) return;
      const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
      const c = canvas.current!;
      c.width = Math.round(img.naturalWidth * scale);
      c.height = Math.round(img.naturalHeight * scale);
      image.current = img;
      redraw();
      setReady(true);
    };
    img.onerror = () => {
      if (live) {
        notify("לא הצלחתי לפתוח את התמונה.");
        onClose();
      }
    };
    img.src = url;
    return () => {
      live = false;
      URL.revokeObjectURL(url);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  /** Pointer position in the canvas's own pixels, whatever size it is shown at. */
  const at = (e: React.PointerEvent): [number, number] => {
    const r = canvas.current!.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * canvas.current!.width, ((e.clientY - r.top) / r.height) * canvas.current!.height];
  };
  const down = (e: React.PointerEvent) => {
    if (!ready) return;
    canvas.current!.setPointerCapture(e.pointerId);
    current.current = { color, width: Math.max(5, canvas.current!.width / 120), points: [at(e)] };
    redraw();
  };
  const move = (e: React.PointerEvent) => {
    if (!current.current) return;
    current.current.points.push(at(e));
    redraw();
  };
  const up = () => {
    if (!current.current) return;
    strokes.current.push(current.current);
    current.current = null;
    setCount(strokes.current.length);
    redraw();
  };

  function save() {
    canvas.current!.toBlob((blob) => {
      if (!blob) return notify("לא הצלחתי לשמור את הסימון.");
      onDone(new File([blob], `annotated-${Date.now()}.png`, { type: "image/png" }));
    }, "image/png");
  }

  return (
    <Sheet title="סמן על הצילום" onClose={onClose}>
      <p className="muted">צייר באצבע על מה שלא בסדר. הסימון נשלח לסוכנים יחד עם הצילום.</p>
      <canvas
        ref={canvas}
        aria-label="התמונה לסימון"
        style={{ width: "100%", height: "auto", maxHeight: "55dvh", objectFit: "contain", touchAction: "none", borderRadius: 12, border: "1px solid var(--line)", background: "var(--track)", cursor: "crosshair" }}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
      />
      <div className="row between wrap">
        <div className="row" role="group" aria-label="צבע">
          {COLORS.map((c) => (
            <button key={c.value} type="button" className="iconbtn" aria-label={c.name} aria-pressed={color === c.value} onClick={() => setColor(c.value)} style={{ background: "transparent", border: color === c.value ? "2px solid var(--ink)" : "2px solid transparent" }}>
              <span style={{ width: 22, height: 22, borderRadius: 11, background: c.value, display: "block" }} />
            </button>
          ))}
        </div>
        <div className="row">
          <button type="button" className="btn sm" disabled={count === 0} onClick={() => { strokes.current.pop(); setCount(strokes.current.length); redraw(); }}>בטל קו</button>
          <button type="button" className="btn sm" disabled={count === 0} onClick={() => { strokes.current = []; setCount(0); redraw(); }}>נקה הכול</button>
        </div>
      </div>
      <div className="row">
        <button type="button" className="btn pri grow" disabled={!ready || count === 0} onClick={save}>צרף את הצילום המסומן</button>
        <button type="button" className="btn grow" onClick={onClose}>ביטול</button>
      </div>
    </Sheet>
  );
}

/** One image to mark: a picture from the phone (screenshot, camera) or one of the task's own result screenshots. */
export type MarkSource = { kind: "file"; file: File } | { kind: "shot"; taskId: number; mediaId: number };

/** Turns a source into a Blob the editor can draw on. */
export async function loadMarkSource(src: MarkSource): Promise<Blob> {
  if (src.kind === "file") return prepareFile(src.file);
  const url = await fetchBlobUrl(`/tasks/${src.taskId}/media/${src.mediaId}`);
  try {
    return await (await fetch(url)).blob();
  } finally {
    URL.revokeObjectURL(url);
  }
}
