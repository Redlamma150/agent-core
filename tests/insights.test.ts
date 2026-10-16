import { describe, expect, it } from "vitest";
import { route } from "../src/agents/router.js";
import { InsightService, UnknownInsightError } from "../src/core/insights.js";
import { SettingsService } from "../src/core/settings.js";
import { openDb } from "../src/db/index.js";

function setup() {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO projects (name, repo_path) VALUES ('p', '/r')").run();
  db.prepare("INSERT INTO tasks (project_id, description) VALUES (1, 'x')").run();
  const settings = new SettingsService(db);
  const call = (agent: string, tokens: number, over: { valid?: number; escalated?: number; ago?: string } = {}) =>
    db.prepare("INSERT INTO llm_calls (task_id, agent, model, input_tokens, output_tokens, valid_output, escalated, created_at) VALUES (1, ?, 'sonnet', ?, 0, ?, ?, datetime('now', ?))")
      .run(agent, tokens, over.valid ?? 1, over.escalated ?? 0, over.ago ?? "-1 hours");
  return { db, settings, insights: new InsightService(db, settings), call };
}

describe("planner on a cheaper model", () => {
  it("is suggested only when the numbers support it", () => {
    const t = setup();
    expect(t.insights.list()).toEqual([]); // no data

    for (let i = 0; i < 4; i++) t.call("planner", 1000);
    for (let i = 0; i < 4; i++) t.call("builder", 1000);
    expect(t.insights.list()).toEqual([]); // too few planner calls

    t.call("planner", 1000);
    const [tip] = t.insights.list();
    expect(tip).toMatchObject({ id: "planner_cheaper", applied: false });
    expect(tip!.body).toContain("5,000"); // measured planner tokens
    expect(tip!.body).toContain("56%"); // 5000 of 9000
  });

  it("is not suggested when the planner needed escalations, produced bad output, or is a small share", () => {
    const a = setup();
    for (let i = 0; i < 5; i++) a.call("planner", 1000, { escalated: i === 0 ? 1 : 0 });
    expect(a.insights.list()).toEqual([]);

    const b = setup();
    for (let i = 0; i < 5; i++) b.call("planner", 1000, { valid: i < 3 ? 1 : 0 });
    expect(b.insights.list()).toEqual([]);

    const c = setup();
    for (let i = 0; i < 5; i++) c.call("planner", 100);
    c.call("builder", 100_000);
    expect(c.insights.list()).toEqual([]);
  });

  it("ignores calls older than a week", () => {
    const t = setup();
    for (let i = 0; i < 6; i++) t.call("planner", 1000, { ago: "-10 days" });
    expect(t.insights.list()).toEqual([]);
  });

  it("applying it routes the planner to Haiku, unapplying restores the table, and escalation still goes to the strong model", () => {
    const t = setup();
    for (let i = 0; i < 5; i++) t.call("planner", 1000);
    t.insights.apply("planner_cheaper");
    expect(t.settings.roleModel("planner")).toBe("haiku");
    expect(t.insights.list()[0]!.applied).toBe(true);

    const input = { role: "planner", consecutiveFailures: 0, escalations: 0, flagged: false } as const;
    expect(route({ ...input, modelOverride: t.settings.roleModel("planner") })).toMatchObject({ action: "run", model: "haiku" });
    expect(route({ ...input, consecutiveFailures: 2, modelOverride: "haiku" })).toMatchObject({ action: "run", model: "opus", escalate: true });
    expect(route({ ...input })).toMatchObject({ model: "sonnet" });

    t.insights.unapply("planner_cheaper");
    expect(t.settings.roleModel("planner")).toBeUndefined();
  });

  it("stays listed while applied even when the data no longer supports it, so it can be switched off", () => {
    const t = setup();
    t.insights.apply("planner_cheaper");
    expect(t.insights.list().map((i) => i.id)).toEqual(["planner_cheaper"]);
  });
});

describe("automatic stash", () => {
  it("is suggested after the same dirty-checkout block came back, and applying it turns the setting on", () => {
    const t = setup();
    const block = (ago: string) => t.db.prepare("INSERT INTO steps (task_id, agent, status, summary, created_at) VALUES (1, 'system', 'merge_failed_dirty', 'x', datetime('now', ?))").run(ago);
    block("-1 days");
    expect(t.insights.list()).toEqual([]);
    block("-2 days");
    expect(t.insights.list()[0]).toMatchObject({ id: "auto_stash", applied: false, gain: "פחות עצירות במיזוג" });
    expect(t.insights.list()[0]!.body).toContain("2 פעמים");

    t.insights.apply("auto_stash");
    expect(t.settings.autoStash()).toBe(true);
    expect(t.insights.list()[0]!.applied).toBe(true);
    t.insights.unapply("auto_stash");
    expect(t.settings.autoStash()).toBe(false);
  });

  it("does not count old blocks", () => {
    const t = setup();
    for (let i = 0; i < 3; i++) t.db.prepare("INSERT INTO steps (task_id, agent, status, summary, created_at) VALUES (1, 'system', 'merge_failed_dirty', 'x', datetime('now', '-30 days'))").run();
    expect(t.insights.list()).toEqual([]);
  });
});

describe("InsightService", () => {
  it("rejects unknown suggestions", () => {
    expect(() => setup().insights.apply("nope")).toThrow(UnknownInsightError);
  });
});
