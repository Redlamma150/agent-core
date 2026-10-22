import { useEffect, useRef, type ReactNode } from "react";
import { useConnected } from "./hooks";
import { aiLabel, pillClass, statusLabel } from "./lib/format";

const ICONS = {
  back: "M9 6l6 6-6 6",
  close: "M6 6l12 12M18 6L6 18",
  plus: "M12 5v14M5 12h14",
  check: "M5 12l5 5 9-10",
  tasks: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  approvals: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8 12l3 3 5-6",
  chat: "M21 12a8 8 0 0 1-11.6 7.1L3 21l1.9-6.2A8 8 0 1 1 21 12z",
  projects: "M3 7h6l2 2h10v10H3z",
  insights: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  settings: "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1",
  camera: "M4 8h3l2-3h6l2 3h3v11H4zM12 9.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z",
  image: "M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM9 8.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM21 16l-5-5-9 9",
  file: "M14 3H6v18h12V7zM14 3v4h4",
  mic: "M12 3a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5 11a7 7 0 0 0 14 0M12 18v3",
  send: "M22 2L11 13M22 2l-7 20-4-9-9-4z",
} as const;
export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 20, color = "currentColor", width = 2 }: { name: IconName; size?: number; color?: string; width?: number }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round">
      <path d={ICONS[name]} />
    </svg>
  );
}

export function StatusPill({ status, label, reverted, paused }: { status: string; label?: string; reverted?: boolean; paused?: boolean }) {
  if (paused) return <span className="pill p-pause">מושהית עד חידוש המכסה</span>;
  if (reverted && status === "merged") return <span className="pill p-undone">המיזוג הוחזר</span>;
  return <span className={`pill ${pillClass(status)}`}>{label ?? statusLabel(status)}</span>;
}

/** Which model did the work. Hidden until an agent has run. */
export function AiBadge({ model }: { model: string | null }) {
  const label = aiLabel(model);
  return label ? <span className="ai">{label}</span> : null;
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange?: () => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" className="sw" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={onChange}>
      <span />
    </button>
  );
}

export function Toggle({ label, sub, checked, onChange, soon }: { label: string; sub?: string; checked: boolean; onChange?: () => void; soon?: boolean }) {
  return (
    <div className={`toggle ${soon ? "soon" : ""}`}>
      <div className="toggle-text">
        <b>{label} {soon && <span className="soon-tag">בקרוב</span>}</b>
        {sub && <span className="muted">{sub}</span>}
      </div>
      <Switch checked={checked} onChange={onChange} label={label} disabled={soon} />
    </div>
  );
}

export interface SegOption<T extends string> { value: T; label: string; disabled?: boolean }

export function Segmented<T extends string>({ options, value, onChange, label }: { options: SegOption<T>[]; value: T; onChange: (v: T) => void; label?: string }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={value === o.value} disabled={o.disabled} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

/** Task stepper: planning, build, approval, merged. */
export function Stepper({ labels, current, status }: { labels: readonly string[]; current: number; status: string }) {
  return (
    <ol className="steps" aria-label="שלבי המשימה">
      {labels.map((label, i) => {
        const done = i < current || (status === "merged" && i === current);
        const cls = done ? "done" : i === current ? "cur" : "";
        return <li key={label} className={`st ${cls}`} aria-current={i === current ? "step" : undefined}><i />{label}</li>;
      })}
    </ol>
  );
}

export function BackButton({ fallback = "/tasks", label = "חזרה" }: { fallback?: string; label?: string }) {
  function back() {
    // Only go back when the previous entry is inside this app; otherwise land on the fallback screen.
    if (window.history.length > 1 && document.referrer.startsWith(window.location.origin)) window.history.back();
    else window.location.hash = `#${fallback}`;
  }
  return <button type="button" className="btn ghost" onClick={back}><Icon name="back" color="var(--accent)" width={2.2} />{label}</button>;
}

export function Skeleton({ count = 2 }: { count?: number }) {
  return <div className="list" aria-busy="true" aria-label="טוען">{Array.from({ length: count }, (_, i) => <div key={i} className="skel" />)}</div>;
}

/** A feature the core does not provide yet: shown, disabled, and honest about it. */
export function Soon({ children }: { children: ReactNode }) {
  return <span className="muted">{children} <span className="soon-tag">בקרוב</span></span>;
}

/** Sheets that are open, newest last: only the top one reacts to Escape and Tab, so a sheet opened from a sheet closes alone. */
const sheetStack: symbol[] = [];

/** Bottom sheet: dialog role, focus moves in and stays in, Escape closes, focus returns when it closes. */
export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const me = Symbol("sheet");
    sheetStack.push(me);
    const previous = document.activeElement as HTMLElement | null;
    const focusable = () => Array.from(ref.current?.querySelectorAll<HTMLElement>("textarea, input, button:not(:disabled), a[href]") ?? []);
    focusable()[0]?.focus();
    function onKey(e: KeyboardEvent) {
      if (sheetStack[sheetStack.length - 1] !== me) return;
      if (e.key === "Escape") return onClose();
      if (e.key !== "Tab") return;
      const items = focusable();
      if (items.length === 0) return;
      const first = items[0]!, last = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); sheetStack.splice(sheetStack.indexOf(me), 1); previous?.focus(); };
  }, [onClose]);
  return (
    <div className="scrim" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <span className="grab" aria-hidden="true" />
        <div className="ttl">{title}</div>
        {children}
      </div>
    </div>
  );
}

/** Header of a main screen: title, live indicator, and optional extra controls. */
export function TopBar({ title, sub, children }: { title: string; sub?: string; children?: ReactNode }) {
  const connected = useConnected();
  return (
    <header className="top">
      <div className="top-title"><h1 className="h1">{title}</h1>{sub && <span className="muted">{sub}</span>}</div>
      <div className="row"><span className={`live ${connected ? "" : "off"}`} role="status">{connected ? "חי" : "מנותק"}</span>{children}</div>
    </header>
  );
}

/** Header of an inner screen: back button and an optional trailing item. */
export function InnerBar({ fallback, children }: { fallback?: string; children?: ReactNode }) {
  return <header className="top"><BackButton fallback={fallback} />{children}</header>;
}
