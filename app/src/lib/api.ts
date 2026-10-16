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

/** Uploads one file to a task. The core wants raw bytes, the file's own type and its name in the query. */
export async function uploadFile(taskId: number, file: File): Promise<void> {
  const token = tokenStore.get();
  if (!token) throw new ApiError(401, null);
  const res = await fetch(`/tasks/${taskId}/media?name=${encodeURIComponent(file.name)}`, {
    method: "POST",
    headers: headers(token, { "content-type": file.type || "application/octet-stream" }),
    body: file,
  });
  if (res.status === 401) {
    onUnauthorized();
    throw new ApiError(401, null);
  }
  if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null));
}

/** An image tag cannot send the Authorization header, so attachments are fetched and shown from a blob URL. */
export async function fetchBlobUrl(path: string): Promise<string> {
  const token = tokenStore.get();
  if (!token) throw new ApiError(401, null);
  const res = await fetch(path, { headers: headers(token) });
  if (!res.ok) throw new ApiError(res.status, null);
  return URL.createObjectURL(await res.blob());
}

/**
 * The launcher opens the app as `/#token=...` so there is nothing to type. The token is moved into storage
 * and removed from the address bar (and from the history entry) right away.
 */
export function consumeTokenFromHash(): void {
  const m = /^#token=([^&]+)/.exec(window.location.hash);
  if (!m?.[1]) return;
  try {
    tokenStore.set(decodeURIComponent(m[1]));
  } catch {
    return; // storage unavailable: the login screen asks for the token instead
  }
  window.history.replaceState(null, "", `${window.location.pathname}#/tasks`);
}

/** Sends a recording to the core, which turns it into text on the computer. The audio is not kept. */
export async function transcribeAudio(blob: Blob): Promise<string> {
  const token = tokenStore.get();
  if (!token) throw new ApiError(401, null);
  const type = (blob.type.split(";")[0] || "audio/webm").toLowerCase();
  const res = await fetch("/transcribe", { method: "POST", headers: headers(token, { "content-type": type }), body: blob });
  if (res.status === 401) {
    onUnauthorized();
    throw new ApiError(401, null);
  }
  const body = (await res.json().catch(() => null)) as { text?: string } | null;
  if (!res.ok) throw new ApiError(res.status, body);
  return body?.text ?? "";
}
