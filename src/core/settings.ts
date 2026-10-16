import type { AgentRole } from "../agents/contract.js";
import type { Db } from "../db/index.js";

/** Models an owner setting may route a role to. Only the cheaper one: the strong model stays the escalation path. */
export const CHEAP_MODEL = "haiku";

/** Small key/value store for choices the owner makes in the app (applied suggestions, the stash switch). */
export class SettingsService {
  constructor(private db: Db) {}

  get(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  set(key: string, value: string | null): void {
    if (value === null) this.db.prepare("DELETE FROM settings WHERE key = ?").run(key);
    else this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')").run(key, value);
  }

  /** Set aside the owner's unsaved changes automatically before every merge. */
  autoStash(): boolean {
    return this.get("auto_stash") === "true";
  }
  setAutoStash(on: boolean): void {
    this.set("auto_stash", on ? "true" : null);
  }

  /** A model the owner routed a role to, or undefined for the default routing table. */
  roleModel(role: AgentRole): string | undefined {
    return this.get(`model.${role}`) ?? undefined;
  }
  setRoleModel(role: AgentRole, model: string | null): void {
    this.set(`model.${role}`, model);
  }
}
