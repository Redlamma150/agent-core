import { z } from "zod";

export const AGENT_ROLES = ["planner", "builder", "tester", "red_team", "operator"] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

export const handoffSchema = z.object({
  task_id: z.string().min(1),
  agent: z.enum(AGENT_ROLES),
  status: z.enum(["done", "failed", "blocked"]),
  summary: z.string(),
  artifacts: z.array(z.string()),
  open_items: z.array(z.string()),
  needs_approval: z.boolean(),
  confidence: z.number().min(0).max(1),
});

export type Handoff = z.infer<typeof handoffSchema>;

/** JSON Schema handed to the SDK so the model is asked for exactly this shape. */
export const handoffJsonSchema: Record<string, unknown> = (() => {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(handoffSchema) as Record<string, unknown>;
  return rest;
})();

export type HandoffResult = { ok: true; handoff: Handoff } | { ok: false; error: string };

/** Validates agent output. Wrong task id or role counts as invalid, same as a schema violation. */
export function parseHandoff(raw: unknown, expected: { taskId: number; role: AgentRole }): HandoffResult {
  const parsed = handoffSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ") };
  if (parsed.data.task_id !== String(expected.taskId)) return { ok: false, error: `task_id mismatch: got ${parsed.data.task_id}` };
  if (parsed.data.agent !== expected.role) return { ok: false, error: `agent mismatch: got ${parsed.data.agent}` };
  return { ok: true, handoff: parsed.data };
}
