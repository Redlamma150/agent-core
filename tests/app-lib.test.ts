import { describe, expect, it } from "vitest";
import { formatDate, parseDbDate, statusLabel } from "../app/src/lib/format.js";
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
