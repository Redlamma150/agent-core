import { parseMessage, type ParsedMessage } from "./commands.js";

export interface GreenApiSettings {
  apiUrl: string;
  instanceId: string;
  token: string;
  ownerPhone: string;
  receiveTimeoutSeconds: number;
}

export interface Notification {
  receiptId: number;
  body: {
    typeWebhook?: string;
    idMessage?: string;
    senderData?: { sender?: string; chatId?: string };
    messageData?: {
      typeMessage?: string;
      textMessageData?: { textMessage?: string };
      textMessage?: string;
    };
  };
}

type Fetch = typeof fetch;

export class GreenApiClient {
  constructor(private s: GreenApiSettings, private fetchFn: Fetch = fetch) {}

  private url(method: string, suffix = ""): string {
    const base = this.s.apiUrl.replace(/\/+$/, "");
    return `${base}/waInstance${this.s.instanceId}/${method}/${this.s.token}${suffix}`;
  }

  /** Long-polls for one notification. Resolves to null when the queue is empty. */
  async receive(): Promise<Notification | null> {
    const res = await this.fetchFn(`${this.url("receiveNotification")}?receiveTimeout=${this.s.receiveTimeoutSeconds}`);
    if (!res.ok) throw new Error(`receiveNotification failed: HTTP ${res.status}`);
    const data = (await res.json()) as Notification | null;
    return data && typeof data.receiptId === "number" ? data : null;
  }

  async delete(receiptId: number): Promise<void> {
    const res = await this.fetchFn(this.url("deleteNotification", `/${receiptId}`), { method: "DELETE" });
    if (!res.ok) throw new Error(`deleteNotification failed: HTTP ${res.status}`);
  }

  async send(chatId: string, message: string): Promise<void> {
    const res = await this.fetchFn(this.url("sendMessage"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chatId, message }),
    });
    if (!res.ok) throw new Error(`sendMessage failed: HTTP ${res.status}`);
  }
}

export interface IncomingText {
  sender: string; // phone digits only
  text: string;
}

/** Extracts a text message from a notification, or null for anything else (state webhooks, media, ...). */
export function extractText(n: Notification): IncomingText | null {
  const b = n.body;
  if (b.typeWebhook !== "incomingMessageReceived") return null;
  const m = b.messageData;
  const text = m?.typeMessage === "extendedTextMessage" ? m.textMessage : m?.textMessageData?.textMessage;
  const sender = b.senderData?.sender;
  if (!text || !sender) return null;
  return { sender: sender.replace(/@.*$/, ""), text };
}

export interface ChannelHandlers {
  /** Returns the Hebrew reply text, or null for no reply. */
  onMessage(msg: ParsedMessage): Promise<string | null> | string | null;
}

export type Logger = (line: string) => void;

/**
 * Processes one notification: whitelist check, parse, reply. Never throws for message-level problems;
 * the caller deletes the notification afterwards so it does not come back.
 */
export async function processNotification(
  n: Notification,
  client: Pick<GreenApiClient, "send">,
  ownerPhone: string,
  handlers: ChannelHandlers,
  log: Logger = console.log,
): Promise<void> {
  const incoming = extractText(n);
  if (!incoming) return;
  if (incoming.sender !== ownerPhone) {
    // Log only the sender, never the content of unknown senders.
    log(`dropped message from non-whitelisted sender ${incoming.sender}`);
    return;
  }
  try {
    const reply = await handlers.onMessage(parseMessage(incoming.text));
    if (reply) await client.send(`${ownerPhone}@c.us`, reply);
  } catch (err) {
    log(`error handling message: ${(err as Error).message}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs the polling loop until the signal aborts. A notification is deleted only after it was processed. */
export async function pollLoop(
  client: GreenApiClient,
  ownerPhone: string,
  handlers: ChannelHandlers,
  signal: AbortSignal,
  log: Logger = console.log,
): Promise<void> {
  let backoffMs = 1000;
  while (!signal.aborted) {
    try {
      const n = await client.receive();
      backoffMs = 1000;
      if (!n) continue;
      await processNotification(n, client, ownerPhone, handlers, log);
      await client.delete(n.receiptId);
    } catch (err) {
      log(`poll error: ${(err as Error).message}`);
      await sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, 30000);
    }
  }
}
