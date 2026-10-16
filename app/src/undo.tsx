import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { TaskRow } from "./lib/format";
import { errorText } from "./screens/common";

const UNDO_MS = 5000;

/** One action waiting out its undo window. The screens show its effect at once; the API call is made only when the window ends. */
export interface Scheduled {
  text: string;
  /** What the lists should show meanwhile. */
  task?: { id: number; patch: Partial<TaskRow> };
  approvalId?: number;
  commit: () => Promise<unknown>;
  /** Turns a failure into the message shown to the owner; defaults to the generic one. */
  onError?: (err: unknown) => string;
}
interface Entry extends Scheduled { id: number }

interface UndoApi {
  schedule: (a: Scheduled) => void;
  notify: (text: string) => void;
  applyTask: (t: TaskRow) => TaskRow;
  approvalHidden: (id: number) => boolean;
  /** Why the last merge of an approval failed, in the core's own words. Cleared when the owner tries again. */
  mergeErrors: Record<number, MergeFailure>;
  setMergeError: (approvalId: number, failure: MergeFailure | null) => void;
  /** Something was done at once; the toast offers to take it back. */
  offerUndo: (text: string, onUndo: () => Promise<unknown>) => void;
}
export interface MergeFailure { message: string; reason: string | null }
const Ctx = createContext<UndoApi | null>(null);
export const useUndo = (): UndoApi => {
  const v = useContext(Ctx);
  if (!v) throw new Error("UndoProvider missing");
  return v;
};

export function UndoProvider({ children, low, onSettled }: { children: ReactNode; low: boolean; onSettled: () => void }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [mergeErrors, setMergeErrors] = useState<Record<number, MergeFailure>>({});
  const [toast, setToast] = useState<{ text: string; undo: boolean; onUndo?: () => Promise<unknown> } | null>(null);
  const pending = useRef<Entry | null>(null);
  const commitTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const seq = useRef(0);
  const settledRef = useRef(onSettled);
  settledRef.current = onSettled;

  const notify = useCallback((text: string) => {
    // An undo toast in progress keeps the stage; the message waits for it.
    if (pending.current) { setTimeout(() => notify(text), UNDO_MS + 100); return; }
    clearTimeout(toastTimer.current);
    setToast({ text, undo: false });
    toastTimer.current = setTimeout(() => setToast(null), UNDO_MS);
  }, []);

  const flush = useCallback(() => {
    clearTimeout(commitTimer.current);
    const p = pending.current;
    if (!p) return;
    pending.current = null;
    setToast((t) => (t?.undo ? null : t));
    void (async () => {
      try {
        await p.commit();
      } catch (err) {
        notify(p.onError ? p.onError(err) : errorText(err));
      } finally {
        settledRef.current();
        setTimeout(() => setEntries((e) => e.filter((x) => x.id !== p.id)), 600);
      }
    })();
  }, [notify]);

  const schedule = useCallback((a: Scheduled) => {
    flush(); // a new action while one is waiting makes the earlier one final right away
    clearTimeout(toastTimer.current);
    const entry: Entry = { ...a, id: ++seq.current };
    pending.current = entry;
    setEntries((e) => [...e, entry]);
    setToast({ text: a.text, undo: true });
    commitTimer.current = setTimeout(flush, UNDO_MS);
  }, [flush]);

  /** For actions that already happened (a revert): the toast stays 5 seconds and "בטל" runs the opposite call. */
  const offerUndo = useCallback((text: string, onUndo: () => Promise<unknown>) => {
    flush();
    clearTimeout(toastTimer.current);
    setToast({ text, undo: true, onUndo });
    toastTimer.current = setTimeout(() => setToast(null), UNDO_MS);
  }, [flush]);

  const undo = useCallback(() => {
    const reverse = toast?.onUndo;
    if (reverse) {
      clearTimeout(toastTimer.current);
      setToast(null);
      void reverse().then(() => settledRef.current(), (err) => notify(errorText(err)));
      return;
    }
    clearTimeout(commitTimer.current);
    const p = pending.current;
    pending.current = null;
    if (p) setEntries((e) => e.filter((x) => x.id !== p.id));
    setToast(null);
  }, [toast, notify]);

  // Closing the app inside the window is not an undo: the action goes out rather than being lost.
  useEffect(() => {
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, [flush]);

  const api = useMemo<UndoApi>(() => ({
    schedule,
    notify,
    offerUndo,
    applyTask: (t) => {
      let out = t;
      for (const e of entries) if (e.task?.id === t.id) out = { ...out, ...e.task.patch };
      return out;
    },
    approvalHidden: (id) => entries.some((e) => e.approvalId === id),
    mergeErrors,
    setMergeError: (id, failure) => setMergeErrors((m) => {
      const next = { ...m };
      if (failure === null) delete next[id]; else next[id] = failure;
      return next;
    }),
  }), [schedule, notify, offerUndo, entries, mergeErrors]);

  return (
    <Ctx.Provider value={api}>
      {children}
      {toast && (
        <div className={`toast ${low ? "low" : ""}`} role="status">
          <span>{toast.text}</span>
          {toast.undo && <button type="button" onClick={undo}>בטל</button>}
        </div>
      )}
    </Ctx.Provider>
  );
}
