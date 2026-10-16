import Database from "better-sqlite3";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export type Db = Database.Database;

const schemaPath = fileURLToPath(new URL("./schema.sql", import.meta.url));

/** Opens the database, creating the file, its directory and all tables on first run. */
export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(readFileSync(schemaPath, "utf8"));
  ensureColumn(db, "tasks", "flagged", "INTEGER NOT NULL DEFAULT 0"); // added in M5; CREATE IF NOT EXISTS skips existing tables
  ensureColumn(db, "tasks", "base_branch", "TEXT");
  ensureColumn(db, "tasks", "title", "TEXT"); // added in M8
  ensureColumn(db, "tasks", "archived_at", "TEXT");
  ensureColumn(db, "tasks", "deleted_at", "TEXT");
  ensureColumn(db, "tasks", "token_extra", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "projects", "test_command", "TEXT");
  ensureColumn(db, "tasks", "reverted_at", "TEXT"); // M17
  ensureColumn(db, "tasks", "revert_commit", "TEXT");
  ensureColumn(db, "attachments", "kind", "TEXT NOT NULL DEFAULT 'upload'"); // M16: 'screenshot' for pictures the core took itself
  return db;
}

function ensureColumn(db: Db, table: string, column: string, ddl: string): void {
  const cols = db.pragma(`table_info(${table})`) as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}
