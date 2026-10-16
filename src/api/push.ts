import type { FastifyInstance } from "fastify";
import webpush from "web-push";
import { z } from "zod";
import type { Db } from "../db/index.js";
import type { CoreEvent, EventBus } from "./events.js";

export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushPayload {
  title: string;
  body: string;
  url: string;
}

export type PushSender = (sub: PushSubscriptionInput, payload: string) => Promise<unknown>;

const subscriptionSchema = z.object({
  endpoint: z.url().refine((u) => u.startsWith("https://"), "endpoint must be https"),
  keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
});

export function createWebPushSender(vapid: { subject: string; publicKey: string; privateKey: string }): PushSender {
  webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
  return (sub, payload) => webpush.sendNotification(sub, payload, { TTL: 3600 });
}

export class PushService {
  constructor(private db: Db, private send: PushSender, private log: (line: string) => void = console.log) {}

  subscribe(sub: PushSubscriptionInput): void {
    this.db
      .prepare("INSERT INTO push_subscriptions (endpoint, p256dh, auth) VALUES (?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth")
      .run(sub.endpoint, sub.keys.p256dh, sub.keys.auth);
  }

  unsubscribe(endpoint: string): void {
    this.db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint);
  }

  count(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM push_subscriptions").get() as { n: number }).n;
  }

  /** Sends to every device. Expired subscriptions (404/410) are removed; other failures are logged without the payload. */
  async notifyAll(payload: PushPayload): Promise<void> {
    const rows = this.db.prepare("SELECT endpoint, p256dh, auth FROM push_subscriptions").all() as { endpoint: string; p256dh: string; auth: string }[];
    const body = JSON.stringify(payload);
    await Promise.allSettled(
      rows.map(async (r) => {
        try {
          await this.send({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } }, body);
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) this.unsubscribe(r.endpoint);
          else this.log(`push failed (status ${status ?? "unknown"})`);
        }
      }),
    );
  }
}

/**
 * Notification texts carry no task content (no descriptions, file names or code). The one free-text part is the short
 * Hebrew reason a task got stuck, which the core wrote or the agent summarised in one sentence.
 */
export function notificationFor(event: CoreEvent): PushPayload | null {
  const d = event.data as { task_id?: number; status?: string; number?: number; percent?: number; reason?: string };
  if (event.type === "approval" && d.status === "pending") {
    return { title: "בקשת אישור חדשה", body: `משימה #${d.task_id} ממתינה לאישור שלך`, url: "/#/approvals" };
  }
  if (event.type === "reminder") {
    return { title: "תזכורת לאישור", body: `משימה #${d.task_id} עדיין ממתינה לאישור (תזכורת ${d.number})`, url: "/#/approvals" };
  }
  if (event.type === "blocked") {
    const reason = d.reason ? `: ${d.reason}` : " וצריכה אותך";
    return { title: "משימה נתקעה", body: `משימה #${d.task_id} נתקעה${reason}`, url: `/#/tasks/${d.task_id}` };
  }
  if (event.type === "stopped") {
    return { title: "המשימה נעצרה", body: `משימה #${d.task_id} נעצרה על ידך`, url: `/#/tasks/${d.task_id}` };
  }
  if (event.type === "merged") {
    return { title: "המשימה מוזגה", body: `משימה #${d.task_id} אושרה ומוזגה לפרויקט`, url: `/#/tasks/${d.task_id}` };
  }
  if (event.type === "budget" && d.percent === 100) {
    return { title: "המשימה נעצרה בתקרה", body: `משימה #${d.task_id} הגיעה לתקרת הטוקנים ונעצרה`, url: `/#/tasks/${d.task_id}` };
  }
  if (event.type === "budget") {
    return { title: "תקרת טוקנים", body: `משימה #${d.task_id} הגיעה ל-${d.percent}% מתקרת הטוקנים`, url: `/#/tasks/${d.task_id}` };
  }
  return null;
}

/** Forwards approval requests and reminders from the event bus to Web Push. */
export function attachPush(bus: EventBus, push: PushService): () => void {
  return bus.subscribe((e) => {
    const payload = notificationFor(e);
    if (payload) void push.notifyAll(payload);
  });
}

export function registerPush(app: FastifyInstance, push: PushService, vapidPublicKey: string): void {
  app.get("/push/public-key", async () => ({ key: vapidPublicKey }));
  app.post("/push/subscribe", async (req, reply) => {
    push.subscribe(subscriptionSchema.parse(req.body));
    return reply.code(204).send();
  });
  app.post("/push/unsubscribe", async (req, reply) => {
    push.unsubscribe(z.object({ endpoint: z.string().min(1) }).parse(req.body).endpoint);
    return reply.code(204).send();
  });
}
