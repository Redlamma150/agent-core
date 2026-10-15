import { isAbsolute, relative } from "node:path";
import type { EventBus } from "../api/events.js";
import type { Db } from "../db/index.js";

export interface ActivityRow {
  id: number;
  task_id: number;
  agent: string;
  tool: string;
  target: string | null;
  created_at: string;
}

const MAX_TARGET = 120;

/**
 * What an agent is doing right now, one row per tool call. Only the tool name and a short target are kept
 * (a file path or a search pattern), never file contents, command lines or tool output, so nothing secret
 * can end up here or in the API.
 */
export class ActivityService {
  constructor(private db: Db, private bus?: EventBus) {}

  record(taskId: number, agent: string, tool: string, target?: string | null): void {
    const info = this.db
      .prepare("INSERT INTO activity (task_id, agent, tool, target) VALUES (?, ?, ?, ?)")
      .run(taskId, agent, tool.slice(0, 40), target ? target.slice(0, MAX_TARGET) : null);
    this.bus?.publish({ type: "activity", data: { task_id: taskId, id: Number(info.lastInsertRowid) } });
  }

  list(taskId: number, afterId = 0, limit = 200): ActivityRow[] {
    return this.db
      .prepare("SELECT id, task_id, agent, tool, target, created_at FROM activity WHERE task_id = ? AND id > ? ORDER BY id DESC LIMIT ?")
      .all(taskId, afterId, limit)
      .reverse() as ActivityRow[];
  }
}

/** Reads the tool calls out of one SDK assistant message. Unknown shapes are ignored. */
export function toolCallsOf(message: unknown, cwd: string): { tool: string; target: string | null }[] {
  const content = (message as { message?: { content?: unknown } })?.message?.content;
  if (!Array.isArray(content)) return [];
  const calls: { tool: string; target: string | null }[] = [];
  for (const block of content as { type?: string; name?: string; input?: Record<string, unknown> }[]) {
    if (block?.type !== "tool_use" || typeof block.name !== "string") continue;
    calls.push({ tool: block.name, target: targetOf(block.name, block.input ?? {}, cwd) });
  }
  return calls;
}

function targetOf(tool: string, input: Record<string, unknown>, cwd: string): string | null {
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : null);
  switch (tool) {
    case "Read":
    case "Edit":
    case "Write":
    case "NotebookEdit": {
      const file = str("file_path") ?? str("notebook_path");
      if (!file) return null;
      const rel = isAbsolute(file) ? relative(cwd, file) : file;
      return rel.startsWith("..") ? file : rel;
    }
    case "Glob":
    case "Grep":
      return str("pattern");
    case "Bash": {
      // Only the program name: arguments (and leading VAR=value assignments) can carry secrets.
      const first = str("command")?.trim().split(/\s+/)[0] ?? null;
      return first && /^[\w./-]+$/.test(first) ? first : null;
    }
    default:
      return null;
  }
}
