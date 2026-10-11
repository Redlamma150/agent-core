import Fastify, { type FastifyInstance } from "fastify";
import type { Db } from "../db/index.js";
import { registerAuth } from "./auth.js";
import { EventBus, registerEvents } from "./events.js";
import { registerRoutes, type Services } from "./routes.js";

export interface ApiDeps extends Services {
  db: Db;
  accessToken: string;
  bus?: EventBus;
  logger?: boolean;
}

export function buildApp({ db, accessToken, tasks, approvals, bus = new EventBus(), logger = false }: ApiDeps): FastifyInstance {
  const app = Fastify({
    logger: logger
      ? {
          level: "info",
          // Log method and path only: no headers (token), query string or body.
          serializers: { req: (r) => ({ method: r.method, path: r.url?.split("?")[0] }) },
        }
      : false,
  });
  registerAuth(app, accessToken);
  registerEvents(app, bus);
  registerRoutes(app, db, { tasks, approvals });
  return app;
}

/**
 * Fastify cannot listen on several hosts from one instance, so each bind address gets its own instance
 * sharing the same database and event bus. Never binds to anything outside `hosts`.
 */
export async function startServers(deps: ApiDeps, hosts: string[], port: number): Promise<FastifyInstance[]> {
  const bus = deps.bus ?? new EventBus();
  const apps: FastifyInstance[] = [];
  try {
    for (const host of hosts) {
      const app = buildApp({ ...deps, bus });
      await app.listen({ host, port });
      apps.push(app);
    }
  } catch (err) {
    await Promise.all(apps.map((a) => a.close()));
    throw err;
  }
  return apps;
}
