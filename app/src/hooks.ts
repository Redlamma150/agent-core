import { createContext, useContext, useEffect, useState, useCallback } from "react";
import { api, ApiError } from "./lib/api";

/** Bumped on every live event from /events; screens refetch when it changes. */
export const LiveContext = createContext(0);

/** False while the live stream to the core is down; action buttons disable themselves then. */
export const ConnectedContext = createContext(true);
export const useConnected = () => useContext(ConnectedContext);

export function useRoute(): string {
  const read = () => window.location.hash.replace(/^#/, "") || "/tasks";
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

export interface Loaded<T> {
  data: T | null;
  error: ApiError | Error | null;
  loading: boolean;
  reload: () => void;
}

export function useApi<T>(path: string): Loaded<T> {
  const live = useContext(LiveContext);
  const [state, setState] = useState<{ data: T | null; error: Error | null; loading: boolean }>({ data: null, error: null, loading: true });
  const [manual, setManual] = useState(0);
  useEffect(() => {
    let cancelled = false;
    api<T>(path)
      .then((data) => !cancelled && setState({ data, error: null, loading: false }))
      .catch((error: Error) => !cancelled && setState((s) => ({ data: s.data, error, loading: false })));
    return () => {
      cancelled = true;
    };
  }, [path, live, manual]);
  const reload = useCallback(() => setManual((n) => n + 1), []);
  return { ...state, reload };
}

/** Re-renders on an interval so relative times ("5 min ago") stay fresh. */
export function useTick(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
