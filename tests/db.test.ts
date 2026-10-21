import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/index.js";

const TABLES = ["activity", "agent_templates", "approvals", "attachments", "chat_media", "llm_calls", "projects", "push_subscriptions", "quota_windows", "settings", "steps", "tasks"];

describe("openDb", () => {
  it("creates the database from scratch on first run", () => {
    const dir = mkdtempSync(join(tmpdir(), "core-"));
    const path = join(dir, "nested", "core.db");
    try {
      expect(existsSync(path)).toBe(false);
      const db = openDb(path);
      expect(existsSync(path)).toBe(true);
      const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
      expect(names).toEqual(TABLES);
      db.close();
      openDb(path).close(); // idempotent on second run
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("enforces task status values and foreign keys", () => {
    const db = openDb(":memory:");
    expect(() => db.prepare("INSERT INTO tasks (project_id, description) VALUES (99, 'x')").run()).toThrow();
    db.prepare("INSERT INTO projects (name, repo_path) VALUES ('p', '/r')").run();
    expect(() => db.prepare("INSERT INTO tasks (project_id, description, status) VALUES (1, 'x', 'bogus')").run()).toThrow();
    db.prepare("INSERT INTO tasks (project_id, description) VALUES (1, 'x')").run();
    expect((db.prepare("SELECT status FROM tasks").get() as { status: string }).status).toBe("received");
  });
});
