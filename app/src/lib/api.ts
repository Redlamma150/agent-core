import { parseSse, type SseEvent } from "./sse";

const TOKEN_KEY = "agent-core-token";

export const tokenStore = {
  get(): string | null {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set(token: string): void {
    localStorage.setItem(TOKEN_KEY, token);
  },
  clear(): void {
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch {
      // storage unavailable: nothing to clear
    }
  },
};

export class ApiError extends Error {
  constructor(readonly status: number, readonly body: unknown) {
    super(`HTTP ${status}`);
  }
}

/** Set by the app shell so any 401 sends the user back to the token screen. */
let onUnauthorized: () => void = () => {};
export const setUnauthorizedHandler = (fn: () => void) => (onUnauthorized = fn);

function headers(token: string, extra?: HeadersInit): Headers {
  const h = new Headers(extra);
  h.set("authorization", `Bearer ${token}`);
  return h;
}

export async function api<T>(path: string, init: { method?: string; body?: unknown; token?: string } = {}): Promise<T> {
  const token = init.token ?? tokenStore.get();
  if (!token) throw new ApiError(401, null);
  const res = await fetch(path, {
    method: init.method ?? "GET",
    headers: headers(token, init.body === undefined ? undefined : { "content-type": "application/json" }),
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (res.status === 401) {
    if (!init.token) onUnauthorized();
    throw new ApiError(401, null);
  }
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}

/**
 * Live updates over SSE. EventSource cannot send an Authorization header, so this reads the stream
 * with fetch and reconnects with backoff until the signal aborts.
 */
export async function streamEvents(onEvent: (e: SseEvent) => void, signal: AbortSignal, onState?: (connected: boolean) => void): Promise<void> {
  let backoff = 1000;
  while (!signal.aborted) {
    try {
      const token = tokenStore.get();
      if (!token) return;
      const res = await fetch("/events", { headers: headers(token), signal });
      if (res.status === 401) return onUnauthorized();
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      onState?.(true);
      backoff = 1000;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parsed = parseSse(buffer);
        buffer = parsed.rest;
        parsed.events.forEach(onEvent);
      }
    } catch {
      if (signal.aborted) return;
    }
    onState?.(false);
    await new Promise((r) => setTimeout(r, backoff));
    backoff = Math.min(backoff * 2, 15000);
  }
}
