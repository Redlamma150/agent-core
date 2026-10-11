import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { Db } from "../db/index.js";
import { AlreadyResolvedError, type ApprovalService } from "../core/approvals.js";
import { InvalidTransitionError, NotFoundError, type TaskService } from "../core/tasks.js";

const notImplemented = (reply: FastifyReply, milestone: string) =>
  reply.code(501).send({ error: "not_implemented", milestone });

const TASK_COLUMNS = "id, project_id, description, status, branch, tokens_used, created_at, updated_at";

const createTaskBody = z.object({ project_id: z.number().int().positive(), description: z.string().trim().min(1).max(5000) });
const decisionBody = z.object({ decision: z.enum(["approve", "reject"]), note: z.string().max(5000).optional() });

export interface Services {
  tasks: TaskService;
  approvals: ApprovalService;
}

export function registerRoutes(app: FastifyInstance, db: Db, { tasks, approvals }: Services): void {
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof NotFoundError) return reply.code(404).send({ error: "not_found" });
    if (err instanceof InvalidTransitionError || err instanceof AlreadyResolvedError) return reply.code(409).send({ error: "conflict", message: err.message });
    if (err instanceof z.ZodError) return reply.code(400).send({ error: "invalid_body", issues: err.issues.map((i) => i.message) });
    if (err instanceof Error && "statusCode" in err && typeof err.statusCode === "number" && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ error: "bad_request" });
    }
    _req.log.error({ err: err instanceof Error ? err.message : "unknown" }, "unhandled error");
    return reply.code(500).send({ error: "internal" });
  });

  app.get("/tasks", async () => db.prepare(`SELECT ${TASK_COLUMNS} FROM tasks ORDER BY id DESC LIMIT 200`).all());
  app.post("/tasks", async (req, reply) => {
    const body = createTaskBody.parse(req.body);
    if (!db.prepare("SELECT 1 FROM projects WHERE id = ?").get(body.project_id)) return reply.code(404).send({ error: "project_not_found" });
    return reply.code(201).send(tasks.create(body.project_id, body.description));
  });

  app.get<{ Params: { id: string } }>("/tasks/:id", async (req, reply) => {
    if (!/^\d+$/.test(req.params.id)) return reply.code(400).send({ error: "invalid_id" });
    const task = db.prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ?`).get(Number(req.params.id));
    if (!task) return reply.code(404).send({ error: "not_found" });
    return task;
  });
  app.post<{ Params: { id: string } }>("/tasks/:id/stop", async (req, reply) => {
    if (!/^\d+$/.test(req.params.id)) return reply.code(400).send({ error: "invalid_id" });
    return tasks.stop(Number(req.params.id));
  });

  app.get("/approvals", async () =>
    db.prepare("SELECT id, task_id, request_text, status, reminders_sent, created_at FROM approvals WHERE status = 'pending' ORDER BY id").all(),
  );
  app.post<{ Params: { id: string } }>("/approvals/:id", async (req, reply) => {
    if (!/^\d+$/.test(req.params.id)) return reply.code(400).send({ error: "invalid_id" });
    const body = decisionBody.parse(req.body);
    return approvals.resolve(Number(req.params.id), body.decision === "approve", body.note);
  });

  app.get("/projects/active", async (_req, reply) => notImplemented(reply, "M6"));
  app.post("/projects/active", async (_req, reply) => notImplemented(reply, "M6"));

  app.get("/usage", async () => {
    const row = db
      .prepare("SELECT COUNT(*) AS calls, COALESCE(SUM(input_tokens),0) AS input_tokens, COALESCE(SUM(output_tokens),0) AS output_tokens FROM llm_calls")
      .get();
    return row;
  });

  app.post("/chat", async (_req, reply) => notImplemented(reply, "M5"));
}
