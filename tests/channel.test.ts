import { describe, expect, it, vi } from "vitest";
import { parseMessage } from "../src/channel/commands.js";
import { createHandlers } from "../src/channel/handlers.js";
import { GreenApiClient, pollLoop, processNotification, type Notification } from "../src/channel/whatsapp.js";
import { openDb } from "../src/db/index.js";

const OWNER = "972501234567";

const text = (sender: string, t: string, receiptId = 1): Notification => ({
  receiptId,
  body: {
    typeWebhook: "incomingMessageReceived",
    senderData: { sender: `${sender}@c.us` },
    messageData: { typeMessage: "textMessage", textMessageData: { textMessage: t } },
  },
});

describe("parseMessage", () => {
  it("recognizes all seven commands", () => {
    const map = { "משימה": "task", "פרויקט": "project", "סטטוס": "status", "אשר": "approve", "דחה": "reject", "עצור": "stop", "עלויות": "costs" };
    for (const [word, name] of Object.entries(map)) expect(parseMessage(word)).toEqual({ kind: "command", name, args: "" });
  });
  it("splits args", () => {
    expect(parseMessage("  משימה  תקן באג בלוגין\nעכשיו ")).toEqual({ kind: "command", name: "task", args: "תקן באג בלוגין\nעכשיו" });
  });
  it("marks free text", () => {
    expect(parseMessage("מה המצב?")).toEqual({ kind: "free", text: "מה המצב?" });
    expect(parseMessage("סטטוסים")).toEqual({ kind: "free", text: "סטטוסים" });
  });
});

describe("processNotification", () => {
  const handlers = createHandlers(openDb(":memory:"));

  it("replies to the owner's status command", async () => {
    const send = vi.fn(async () => {});
    await processNotification(text(OWNER, "סטטוס"), { send }, OWNER, handlers, () => {});
    expect(send).toHaveBeenCalledWith(`${OWNER}@c.us`, expect.stringContaining("המערכת פעילה"));
  });

  it("logs and does not reply to another number", async () => {
    const send = vi.fn(async () => {});
    const log = vi.fn();
    await processNotification(text("972509999999", "סטטוס"), { send }, OWNER, handlers, log);
    expect(send).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("972509999999"));
  });

  it("ignores non-text notifications", async () => {
    const send = vi.fn(async () => {});
    await processNotification({ receiptId: 2, body: { typeWebhook: "stateInstanceChanged" } }, { send }, OWNER, handlers, () => {});
    expect(send).not.toHaveBeenCalled();
  });
});

describe("pollLoop", () => {
  it("deletes a notification only after processing it, and hits the right URLs", async () => {
    const calls: string[] = [];
    const abort = new AbortController();
    let polls = 0;
    const fetchFn = (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url}`);
      if (url.includes("receiveNotification")) {
        polls++;
        if (polls > 1) abort.abort();
        return new Response(JSON.stringify(polls === 1 ? text(OWNER, "סטטוס", 77) : null));
      }
      return new Response(JSON.stringify({ idMessage: "x" }));
    }) as unknown as typeof fetch;

    const client = new GreenApiClient(
      { apiUrl: "https://api.test/", instanceId: "11", token: "TOK", ownerPhone: OWNER, receiveTimeoutSeconds: 5 },
      fetchFn,
    );
    await pollLoop(client, OWNER, createHandlers(openDb(":memory:")), abort.signal, () => {});

    const order = calls.map((c) => c.split(" ")[1]!.split("/").slice(-3).join("/"));
    expect(calls[0]).toBe("GET https://api.test/waInstance11/receiveNotification/TOK?receiveTimeout=5");
    expect(calls.findIndex((c) => c.includes("sendMessage"))).toBeLessThan(calls.findIndex((c) => c.includes("deleteNotification")));
    expect(calls).toContain("DELETE https://api.test/waInstance11/deleteNotification/TOK/77");
    expect(order.length).toBeGreaterThan(2);
  });
});
