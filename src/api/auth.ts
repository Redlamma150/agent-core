import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";

const digest = (s: string) => createHash("sha256").update(s).digest();

/** Constant-time comparison of a presented token against the expected one. */
export function tokenMatches(header: string | undefined, expected: string): boolean {
  const m = /^Bearer (.+)$/.exec(header ?? "");
  if (!m?.[1]) return false;
  return timingSafeEqual(digest(m[1]), digest(expected));
}

/** Rejects every request without a valid bearer token. Logs method and path only, never headers, query or body. */
export function registerAuth(app: FastifyInstance, token: string): void {
  app.addHook("onRequest", async (request, reply) => {
    if (tokenMatches(request.headers.authorization, token)) return;
    request.log.warn({ method: request.method, path: request.url.split("?")[0] }, "rejected unauthenticated request");
    reply.code(401).send({ error: "unauthorized" });
    return reply;
  });
}
