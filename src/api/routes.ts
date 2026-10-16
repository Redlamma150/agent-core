import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Db } from "../db/index.js";
import { AlreadyResolvedError, type ApprovalService } from "../core/approvals.js";
import { MergeError } from "../core/git.js";
import type { TaskDriver } from "../core/pipeline.js";
import type { ActivityService } from "../core/activity.js";
import { createReadStream, existsSync } from "node:fs";
import { basename } from "node:path";
import { LocalActionError, isLocalRequest, type LocalActions } from "../core/local.js";
import { ALLOWED_MIME, MAX_FILE_BYTES, MediaError, type MediaService } from "../core/media.js";
import { OperatorBusyError, OperatorFailedError, MAX_HISTORY, MAX_TEXT, type OperatorService } from "../core/operator.js";
import { registerProject } from "../core/projects.js";
import { InvalidActionError, InvalidTransitionError, NotFoundError, type TaskService } from "../core/tasks.js";

const notImplemented = (reply: FastifyReply, milestone: string) =>
  reply.code(501).send({ error: "not_implemented", milestone });

const TASK_COLUMNS =
  "t.id, t.project_id, p.name AS project_name, t.title, t.description, t.status, t.branch, t.tokens_used, t.token_extra, t.flagged, t.archived_at, t.deleted_at, t.created_at, t.updated_at";
const TASK_FROM = "FROM tasks t JOIN projects p ON p.id = t.project_id";
/** Why a blocked or stopped task stopped: the summary of the step that moved it there. */
const REASON = "(SELECT summary FROM steps WHERE task_id = t.id AND to_status IN ('blocked','stopped') ORDER BY id DESC LIMIT 1) AS reason";
const VIEWS: Record<string, string> = {
  active: "t.deleted_at IS NULL AND t.archived_at IS NULL",
  archived: "t.deleted_at IS NULL AND t.archived_at IS NOT NULL",
  trash: "t.deleted_at IS NOT NULL",
};

const createTaskBody = z.object({ project_id: z.number().int().positive(), description: z.string().trim().min(1).max(5000), flagged: z.boolean().optional(), hold: z.boolean().optional() });
const editTaskBody = z.object({ title: z.string().trim().min(1).max(80).optional(), description: z.string().trim().min(1).max(5000).optional() }).refine((b) => b.title !== undefined || b.description !== undefined, "nothing to change");
const continueBody = z.object({ note: z.string().trim().max(5000).optional() });
const decisionBody = z.object({ decision: z.enum(["approve", "reject"]), note: z.string().max(5000).optional() });

export interface Services {
  tasks: TaskService;
  approvals: ApprovalService;
  driver: TaskDriver;
  activity?: ActivityService;
  media?: MediaService;
  local?: LocalActions;
  operator?: OperatorService;
}

export function registerRoutes(app: FastifyInstance, db: Db, { tasks, driver, activity, media, local, operator }: Services): void {
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof NotFoundError) return reply.code(404).send({ error: "not_found" });
    if (err instanceof MergeError) return reply.code(409).send({ error: "merge_failed", message: err.message });
    if (err instanceof InvalidActionError || err instanceof InvalidTransitionError || err instanceof AlreadyResolvedError) return reply.code(409).send({ error: "conflict", message: err.message });
    if (err instanceof OperatorBusyError) return reply.code(429).send({ error: "busy", message: "המתפעל עונה כרגע להודעה אחרת. נסה שוב בעוד רגע." });
    if (err instanceof OperatorFailedError) {
      _req.log.error({ err: err.message.slice(0, 200) }, "operator failed");
      return reply.code(502).send({ error: "operator_failed", message: "המתפעל לא הצליח לענות. נסה שוב." });
    }
    if (err instanceof MediaError) return reply.code(400).send({ error: "media", message: err.message });
    if (err instanceof LocalActionError) return reply.code(501).send({ error: "local_unavailable", message: err.message });
    if (err instanceof Error && "statusCode" in err && err.statusCode === 413) return reply.code(413).send({ error: "media", message: "הקובץ גדול מדי (עד 15MB)." });
    if (err instanceof z.ZodError) return reply.code(400).send({ error: "invalid_body", issues: err.issues.map((i) => i.message) });
    if (err instanceof Error && "statusCode" in err && typeof err.statusCode === "number" && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ error: "bad_request" });
    }
    _req.log.error({ err: err instanceof Error ? err.message : "unknown" }, "unhandled error");
    return reply.code(500).send({ error: "internal" });
  });

  const taskId = (raw: string): number | null => (/^\d+$/.test(raw) ? Number(raw) : null);
  const oneTask = (id: number) => db.prepare(`SELECT ${TASK_COLUMNS}, ${REASON} ${TASK_FROM} WHERE t.id = ?`).get(id);

  app.get<{ Querystring: { view?: string } }>("/tasks", async (req, reply) => {
    const where = VIEWS[req.query.view ?? "active"];
    if (!where) return reply.code(400).send({ error: "invalid_view" });
    return db.prepare(`SELECT ${TASK_COLUMNS}, ${REASON} ${TASK_FROM} WHERE ${where} ORDER BY t.id DESC LIMIT 200`).all();
  });
  app.get("/projects", async () => db.prepare("SELECT id, name, repo_path FROM projects ORDER BY name").all());

  // ---- things that only work from this computer itself (not from the phone) ----------------------------------------
  const localOnly = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (local && isLocalRequest(req)) return true;
    reply.code(403).send({ error: "local_only", message: "הפעולה זמינה רק מהמחשב עצמו, לא מהנייד." });
    return false;
  };
  const openBody = z.object({ target: z.enum(["folder", "editor"]) });

  app.get<{ Params: { id: string } }>("/tasks/:id/location", async (req, reply) => {
    const id = taskId(req.params.id);
    if (id === null) return reply.code(400).send({ error: "invalid_id" });
    tasks.get(id);
    return driver.locate(id);
  });
  app.post<{ Params: { id: string } }>("/tasks/:id/open", async (req, reply) => {
    const id = taskId(req.params.id);
    if (id === null) return reply.code(400).send({ error: "invalid_id" });
    if (!localOnly(req, reply)) return;
    const where = (tasks.get(id), driver.locate(id));
    if (!where.exists) return reply.code(404).send({ error: "not_found", message: "התיקייה כבר לא קיימת." });
    await local!.open(where.path, openBody.parse(req.body).target);
    return reply.code(204).send();
  });
  app.post<{ Params: { id: string } }>("/projects/:id/open", async (req, reply) => {
    const id = taskId(req.params.id);
    if (id === null) return reply.code(400).send({ error: "invalid_id" });
    if (!localOnly(req, reply)) return;
    const row = db.prepare("SELECT repo_path FROM projects WHERE id = ?").get(id) as { repo_path: string } | undefined;
    if (!row) return reply.code(404).send({ error: "not_found" });
    if (!existsSync(row.repo_path)) return reply.code(404).send({ error: "not_found", message: "התיקייה כבר לא קיימת." });
    await local!.open(row.repo_path, openBody.parse(req.body).target);
    return reply.code(204).send();
  });
  /** Opens the native folder dialog on the computer and returns the chosen path (null if cancelled). */
  app.post("/projects/pick", async (req, reply) => {
    if (!localOnly(req, reply)) return;
    return { path: await local!.pickFolder() };
  });
  app.post("/projects", async (req, reply) => {
    if (!localOnly(req, reply)) return;
    const body = z.object({ path: z.string().trim().min(1), name: z.string().trim().min(1).max(60).optional(), test_command: z.string().trim().max(200).optional() }).parse(req.body);
    try {
      const { id, warnings } = await registerProject(db, { name: body.name ?? (basename(body.path) || body.path), repoPath: body.path, testCommand: body.test_command });
      return reply.code(201).send({ id, warnings });
    } catch (err) {
      return reply.code(400).send({ error: "invalid_project", message: (err as Error).message });
    }
  });

  // ---- attachments -------------------------------------------------------------------------------------------------
  // Raw bytes in the body, the file name in ?name=. One request per file.
  app.addContentTypeParser([...ALLOWED_MIME], { parseAs: "buffer", bodyLimit: MAX_FILE_BYTES }, (_req, body, done) => done(null, body));
  app.get<{ Params: { id: string } }>("/tasks/:id/media", async (req, reply) => {
    const id = taskId(req.params.id);
    if (id === null) return reply.code(400).send({ error: "invalid_id" });
    tasks.get(id);
    return media?.list(id) ?? [];
  });
  app.post<{ Params: { id: string }; Querystring: { name?: string } }>("/tasks/:id/media", async (req, reply) => {
    const id = taskId(req.params.id);
    if (id === null) return reply.code(400).send({ error: "invalid_id" });
    if (!media) return reply.code(501).send({ error: "not_implemented" });
    const mime = (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    if (!Buffer.isBuffer(req.body)) throw new MediaError("סוג הקובץ לא נתמך. אפשר תמונות, PDF וקבצי טקסט.");
    return reply.code(201).send(media.save(id, req.query.name ?? "file", mime, req.body));
  });
  app.get<{ Params: { id: string; mid: string } }>("/tasks/:id/media/:mid", async (req, reply) => {
    const id = taskId(req.params.id);
    const mid = taskId(req.params.mid);
    if (id === null || mid === null) return reply.code(400).send({ error: "invalid_id" });
    if (!media) return reply.code(501).send({ error: "not_implemented" });
    const f = media.file(id, mid);
    if (!existsSync(f.path)) return reply.code(404).send({ error: "not_found" });
    return reply
      .header("content-type", f.mime)
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "sandbox")
      .header("content-disposition", `inline; filename*=UTF-8''${encodeURIComponent(f.name)}`)
      .send(createReadStream(f.path));
  });
  app.delete<{ Params: { id: string; mid: string } }>("/tasks/:id/media/:mid", async (req, reply) => {
    const id = taskId(req.params.id);
    const mid = taskId(req.params.mid);
    if (id === null || mid === null) return reply.code(400).send({ error: "invalid_id" });
    media?.remove(id, mid);
    return reply.code(204).send();
  });
  app.post("/tasks", async (req, reply) => {
    const body = createTaskBody.parse(req.body);
    if (!db.prepare("SELECT 1 FROM projects WHERE id = ?").get(body.project_id)) return reply.code(404).send({ error: "project_not_found" });
    const task = tasks.create(body.project_id, body.description, body.flagged);
    // `hold`: the app attaches files first and then starts the task, so the agent sees them from its first step.
    if (!body.hold) driver.start(task.id);
    return reply.code(201).send(task);
  });
  app.post<{ Params: { id: string } }>("/tasks/:id/start", async (req, reply) => {
    const id = taskId(req.params.id);
    if (id === null) return reply.code(400).send({ error: "invalid_id" });
    const task = tasks.get(id);
    if (task.status !== "received") throw new InvalidActionError(`task is already ${task.status}`);
    driver.start(id);
    return oneTask(id);
  });

  app.get<{ Params: { id: string } }>("/tasks/:id", async (req, reply) => {
    const id = taskId(req.params.id);
    if (id === null) return reply.code(400).send({ error: "invalid_id" });
    return oneTask(id) ?? reply.code(404).send({ error: "not_found" });
  });
  app.get<{ Params: { id: string }; Querystring: { after?: string } }>("/tasks/:id/activity", async (req, reply) => {
    const id = taskId(req.params.id);
    if (id === null) return reply.code(400).send({ error: "invalid_id" });
    tasks.get(id);
    return activity?.list(id, Number(req.query.after) || 0) ?? [];
  });
  app.get<{ Params: { id: string } }>("/tasks/:id/steps", async (req, reply) => {
    const id = taskId(req.params.id);
    if (id === null) return reply.code(400).send({ error: "invalid_id" });
    tasks.get(id);
    return db.prepare("SELECT id, agent, status, from_status, to_status, summary, created_at FROM steps WHERE task_id = ? ORDER BY id").all(id);
  });
  app.patch<{ Params: { id: string } }>("/tasks/:id", async (req, reply) => {
    const id = taskId(req.params.id);
    if (id === null) return reply.code(400).send({ error: "invalid_id" });
    tasks.update(id, editTaskBody.parse(req.body));
    return oneTask(id);
  });
  app.post<{ Params: { id: string } }>("/tasks/:id/continue", async (req, reply) => {
    const id = taskId(req.params.id);
    if (id === null) return reply.code(400).send({ error: "invalid_id" });
    driver.continueTask(id, continueBody.parse(req.body ?? {}).note);
    return oneTask(id);
  });
  app.post<{ Params: { id: string } }>("/tasks/:id/duplicate", async (req, reply) => {
    const id = taskId(req.params.id);
    if (id === null) return reply.code(400).send({ error: "invalid_id" });
    return reply.code(201).send(oneTask(driver.duplicate(id).id));
  });
  for (const [path, run] of [
    ["archive", (id: number) => tasks.archive(id, true)],
    ["unarchive", (id: number) => tasks.archive(id, false)],
    ["restore", (id: number) => tasks.restore(id)],
  ] as const) {
    app.post<{ Params: { id: string } }>(`/tasks/:id/${path}`, async (req, reply) => {
      const id = taskId(req.params.id);
      if (id === null) return reply.code(400).send({ error: "invalid_id" });
      run(id);
      return oneTask(id);
    });
  }
  /** Moves the task to the trash; it is removed for good after 30 days. */
  app.delete<{ Params: { id: string } }>("/tasks/:id", async (req, reply) => {
    const id = taskId(req.params.id);
    if (id === null) return reply.code(400).send({ error: "invalid_id" });
    tasks.trash(id);
    return oneTask(id);
  });
  app.post<{ Params: { id: string } }>("/tasks/:id/stop", async (req, reply) => {
    if (!/^\d+$/.test(req.params.id)) return reply.code(400).send({ error: "invalid_id" });
    return driver.stop(Number(req.params.id));
  });

  app.get("/approvals", async () =>
    db.prepare("SELECT id, task_id, request_text, status, reminders_sent, created_at FROM approvals WHERE status = 'pending' ORDER BY id").all(),
  );
  app.post<{ Params: { id: string } }>("/approvals/:id", async (req, reply) => {
    if (!/^\d+$/.test(req.params.id)) return reply.code(400).send({ error: "invalid_id" });
    const body = decisionBody.parse(req.body);
    return driver.resolveApproval(Number(req.params.id), body.decision === "approve", body.note);
  });

  app.get("/projects/active", async (_req, reply) => notImplemented(reply, "M6"));
  app.post("/projects/active", async (_req, reply) => notImplemented(reply, "M6"));

  app.get("/usage", async () => {
    const sum = "COUNT(*) AS calls, COALESCE(SUM(input_tokens),0) AS input_tokens, COALESCE(SUM(output_tokens),0) AS output_tokens";
    const since = (modifier: string) => db.prepare(`SELECT ${sum} FROM llm_calls WHERE created_at >= datetime('now', ?)`).get(modifier);
    return {
      ...(db.prepare(`SELECT ${sum} FROM llm_calls`).get() as object),
      // Windows for the quota meter: the Claude plan limits usage in rolling windows, so recent usage is what matters.
      last_5h: since("-5 hours"),
      last_24h: since("-24 hours"),
      last_7d: since("-7 days"),
      top_tasks: db
        .prepare(
          `SELECT t.id, t.title, SUM(c.input_tokens + c.output_tokens) AS tokens FROM llm_calls c JOIN tasks t ON t.id = c.task_id
           WHERE c.created_at >= datetime('now', '-7 days') GROUP BY t.id ORDER BY tokens DESC LIMIT 5`,
        )
        .all(),
    };
  });

  const chatBody = z.object({
    text: z.string().trim().min(1).max(MAX_TEXT),
    history: z.array(z.object({ from: z.enum(["me", "system"]), text: z.string().max(MAX_TEXT) })).max(MAX_HISTORY).optional(),
  });
  /** Free text to the operator agent: answers questions about the system and can start, stop or continue tasks. */
  app.post("/chat", async (req, reply) => {
    if (!operator) return notImplemented(reply, "M11");
    const body = chatBody.parse(req.body);
    return operator.chat(body.text, body.history);
  });
}
