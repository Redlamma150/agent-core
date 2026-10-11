import { describe, expect, it, vi } from "vitest";
import { EventBus } from "../src/api/events.js";
import { attachPush, notificationFor, PushService, type PushSubscriptionInput } from "../src/api/push.js";
import { buildApp } from "../src/api/server.js";
import { openDb } from "../src/db/index.js";
import { services } from "./api.test.js";

const TOKEN = "t".repeat(40);
const auth = { authorization: `Bearer ${TOKEN}` };
const sub = (n: number): PushSubscriptionInput => ({ endpoint: `https://push.example/${n}`, keys: { p256dh: "k", auth: "a" } });

describe("PushService", () => {
  it("stores subscriptions once per endpoint and sends to all", async () => {
    const send = vi.fn(async () => {});
    const push = new PushService(openDb(":memory:"), send, () => {});
    push.subscribe(sub(1));
    push.subscribe(sub(1));
    push.subscribe(sub(2));
    expect(push.count()).toBe(2);
    await push.notifyAll({ title: "t", body: "b", url: "/" });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("drops expired subscriptions (410/404) and keeps the rest on other errors", async () => {
    const log = vi.fn();
    const push = new PushService(
      openDb(":memory:"),
      async (s) => {
        if (s.endpoint.endsWith("/1")) throw Object.assign(new Error("gone"), { statusCode: 410 });
        if (s.endpoint.endsWith("/2")) throw Object.assign(new Error("boom"), { statusCode: 500 });
      },
      log,
    );
    [1, 2, 3].forEach((n) => push.subscribe(sub(n)));
    await push.notifyAll({ title: "t", body: "SECRET-BODY", url: "/" });
    expect(push.count()).toBe(2);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.mock.calls)).not.toContain("SECRET-BODY");
  });
});

describe("notifications", () => {
  it("fires for a pending approval and for reminders, in Hebrew, without task text", () => {
    const a = notificationFor({ type: "approval", data: { id: 1, task_id: 7, status: "pending" } });
    expect(a).toMatchObject({ title: "בקשת אישור חדשה", url: "/#/approvals" });
    expect(a?.body).toContain("#7");
    expect(notificationFor({ type: "reminder", data: { approval_id: 1, task_id: 7, number: 2 } })?.title).toBe("תזכורת לאישור");
  });

  it("warns about the token cap in Hebrew with a link to the task", () => {
    expect(notificationFor({ type: "budget", data: { task_id: 4, percent: 80 } })).toEqual({
      title: "תקרת טוקנים",
      body: "משימה #4 הגיעה ל-80% מתקרת הטוקנים",
      url: "/#/tasks/4",
    });
  });

  it("ignores everything else", () => {
    expect(notificationFor({ type: "approval", data: { id: 1, task_id: 7, status: "approved" } })).toBeNull();
    expect(notificationFor({ type: "task", data: { id: 7, status: "planning" } })).toBeNull();
  });

  it("an approval request and its reminders reach the device end to end", async () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO projects (name, repo_path) VALUES ('p', '/r')").run();
    const bus = new EventBus();
    const sent: string[] = [];
    const push = new PushService(db, async (_s, payload) => void sent.push(payload), () => {});
    push.subscribe(sub(1));
    attachPush(bus, push);
    const svc = { ...services(db, bus), push };
    const task = svc.tasks.create(1, "x");
    svc.tasks.transition(task.id, "planning");
    const t0 = new Date("2026-01-01T10:00:00Z");
    svc.approvals.request(task.id, "merge?", t0);
    await svc.approvals.sendDueReminders((a, n) => bus.publish({ type: "reminder", data: { approval_id: a.id, task_id: a.task_id, number: n } }), new Date(t0.getTime() + 10 * 60_000));
    await new Promise((r) => setTimeout(r, 10));
    expect(sent.map((s) => JSON.parse(s).title)).toEqual(["בקשת אישור חדשה", "תזכורת לאישור"]);
  });
});

describe("push routes", () => {
  const setup = () => {
    const db = openDb(":memory:");
    const svc = services(db);
    return { svc, app: buildApp({ db, accessToken: TOKEN, ...svc }) };
  };

  it("returns the public key and stores a subscription", async () => {
    const { app, svc } = setup();
    expect((await app.inject({ url: "/push/public-key", headers: auth })).json()).toEqual({ key: "PUBKEY" });
    const res = await app.inject({ method: "POST", url: "/push/subscribe", headers: auth, payload: sub(1) as object });
    expect(res.statusCode).toBe(204);
    expect(svc.push.count()).toBe(1);
    await app.inject({ method: "POST", url: "/push/unsubscribe", headers: auth, payload: { endpoint: sub(1).endpoint } });
    expect(svc.push.count()).toBe(0);
  });

  it("rejects malformed and non-https subscriptions", async () => {
    const { app } = setup();
    for (const payload of [{}, { endpoint: "http://insecure/x", keys: { p256dh: "k", auth: "a" } }, { endpoint: "https://x/y", keys: {} }]) {
      expect((await app.inject({ method: "POST", url: "/push/subscribe", headers: auth, payload })).statusCode).toBe(400);
    }
  });
});
