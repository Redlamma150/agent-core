import { describe, expect, it } from "vitest";
import { activityLabel, GROUPS, relativeTime, stageOf, stepLabel, taskTitle, formatDate, parseDbDate, statusLabel } from "../app/src/lib/format.js";
import { parseSse } from "../app/src/lib/sse.js";

describe("parseSse", () => {
  it("parses complete frames, skips comments, and keeps a partial tail", () => {
    const { events, rest } = parseSse(': connected\n\nevent: task\ndata: {"id":1}\n\n: ping\n\nevent: appr');
    expect(events).toEqual([{ type: "task", data: { id: 1 } }]);
    expect(rest).toBe("event: appr");
  });
  it("completes a frame split across chunks", () => {
    const first = parseSse('event: task\ndata: {"id"');
    expect(first.events).toEqual([]);
    expect(parseSse(first.rest + ':2}\n\n').events).toEqual([{ type: "task", data: { id: 2 } }]);
  });
  it("skips malformed JSON without breaking the stream", () => {
    const { events } = parseSse("event: x\ndata: {oops\n\nevent: y\ndata: 1\n\n");
    expect(events).toEqual([{ type: "y", data: 1 }]);
  });
});

describe("format", () => {
  it("labels every task status in Hebrew", () => {
    for (const s of ["received", "planning", "in_progress", "awaiting_approval", "merged", "blocked", "stopped"]) {
      expect(statusLabel(s)).toMatch(/[֐-׿]/);
    }
    expect(statusLabel("unknown")).toBe("unknown");
  });
  it("reads SQLite UTC and ISO dates the same way", () => {
    expect(parseDbDate("2026-01-01 10:00:00").toISOString()).toBe("2026-01-01T10:00:00.000Z");
    expect(parseDbDate("2026-01-01T10:00:00.000Z").toISOString()).toBe("2026-01-01T10:00:00.000Z");
    expect(formatDate("garbage")).toBe("garbage");
  });
});

describe("task view helpers", () => {
  const now = Date.parse("2026-01-01T12:00:00Z");
  it("describes how long ago something happened", () => {
    expect(relativeTime("2026-01-01 11:59:40", now)).toBe("עכשיו");
    expect(relativeTime("2026-01-01 11:45:00", now)).toBe("לפני 15 דק׳");
    expect(relativeTime("2026-01-01 09:00:00", now)).toBe("לפני 3 שע׳");
  });
  it("covers every status in exactly one home group", () => {
    const all = Object.values(GROUPS).flatMap((g) => [...g.statuses]).sort();
    expect(all).toEqual(["awaiting_approval", "blocked", "in_progress", "merged", "planning", "received", "stopped"]);
  });
  it("puts blocked and stopped tasks at the last stage they reached", () => {
    expect(stageOf("planning")).toBe(0);
    expect(stageOf("in_progress")).toBe(1);
    expect(stageOf("merged")).toBe(3);
    expect(stageOf("blocked", [null, "planning"])).toBe(0);
    expect(stageOf("stopped", ["planning", "in_progress"])).toBe(1);
    expect(stageOf("blocked", ["in_progress", "awaiting_approval"])).toBe(2);
  });
  it("labels activity, steps and titles in Hebrew with sensible fallbacks", () => {
    expect(activityLabel("Read")).toMatch(/[֐-׿]/);
    expect(activityLabel("SomethingNew")).toBe("SomethingNew");
    expect(stepLabel({ agent: "system", status: "done", to_status: "blocked" })).toBe("נחסמה");
    expect(stepLabel({ agent: "system", status: "escalation", to_status: null })).toMatch(/[֐-׿]/);
    expect(stepLabel({ agent: "planner", status: "done", to_status: null })).toBe("התוכנית מוכנה");
    expect(taskTitle({ title: null, description: "שורה ראשונה\nשנייה" })).toBe("שורה ראשונה");
    expect(taskTitle({ title: "כותרת", description: "x" })).toBe("כותרת");
  });
});
