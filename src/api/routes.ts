import type { FastifyInstance, FastifyReply } from "fastify";
import type { Db } from "../db/index.js";

const notImplemented = (reply: FastifyReply, milestone: string) =>
  reply.code(501).send({ error: "not_implemented", milestone });

const TASK_COLUMNS = "id, project_id, description, status, branch, tokens_used, created_at, updated_at";

export function registerRoutes(app: FastifyInstance, db: Db): void {
  app.get("/tasks", async () => db.prepare(`SELECT ${TASK_COLUMNS} FROM tasks ORDER BY id DESC LIMIT 200`).all());
  app.post("/tasks", async (_req, reply) => notImplemented(reply, "M3"));

  app.get<{ Params: { id: string } }>("/tasks/:id", async (req, reply) => {
    if (!/^\d+$/.test(req.params.id)) return reply.code(400).send({ error: "invalid_id" });
    const task = db.prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ?`).get(Number(req.params.id));
    if (!task) return reply.code(404).send({ error: "not_found" });
    return task;
  });
  app.post("/tasks/:id/stop", async (_req, reply) => notImplemented(reply, "M3"));

  app.get("/approvals", async () =>
    db.prepare("SELECT id, task_id, request_text, status, reminders_sent, created_at FROM approvals WHERE status = 'pending' ORDER BY id").all(),
  );
  app.post("/approvals/:id", async (_req, reply) => notImplemented(reply, "M3"));

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
