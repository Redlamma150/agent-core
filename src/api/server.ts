import { existsSync } from "node:fs";
import { resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import type { Db } from "../db/index.js";
import { registerAuth } from "./auth.js";
import { EventBus, registerEvents } from "./events.js";
import { registerPush, type PushService } from "./push.js";
import { registerRoutes, type Services } from "./routes.js";

export interface ApiDeps extends Services {
  db: Db;
  accessToken: string;
  push: PushService;
  vapidPublicKey: string;
  /** Directory with the built PWA. Served without auth: it contains no secrets, the token is typed into the app. */
  staticDir?: string;
  bus?: EventBus;
  logger?: boolean;
  /** Where logs go instead of stdout (tests read them to check what is and is not logged). */
  logStream?: NodeJS.WritableStream;
}

export function buildApp({ db, accessToken, tasks, approvals, driver, activity, media, local, operator, push, vapidPublicKey, staticDir, bus = new EventBus(), logger = false, logStream }: ApiDeps): FastifyInstance {
  const app = Fastify({
    logger: logger || logStream
      ? {
          level: "info",
          ...(logStream ? { stream: logStream } : {}),
          // Log method and path only: no headers (token), query string or body.
          serializers: { req: (r) => ({ method: r.method, path: r.url?.split("?")[0] }) },
        }
      : false,
  });

  // Everything that returns data lives in this scope, behind the bearer-token hook.
  app.register(async (api) => {
    registerAuth(api, accessToken);
    registerEvents(api, bus);
    registerRoutes(api, db, { tasks, approvals, driver, activity, media, local, operator });
    registerPush(api, push, vapidPublicKey);
  });

  if (staticDir && existsSync(resolve(staticDir, "index.html"))) {
    app.register(fastifyStatic, {
      root: resolve(staticDir),
      wildcard: false, // only files that exist at startup get a route; no catch-all that could shadow the API
      index: "index.html",
      setHeaders: (res, path) => {
        res.header("x-content-type-options", "nosniff");
        // The service worker and entry page must always be revalidated so app updates reach the phone.
        if (/(\/sw\.js|\/index\.html|\.webmanifest)$/.test(path)) res.header("cache-control", "no-cache");
      },
    });
  }
  return app;
}

/**
 * Fastify cannot listen on several hosts from one instance, so each bind address gets its own instance
 * sharing the same database and event bus. Never binds to anything outside `hosts`.
 */
export async function startServers(deps: ApiDeps, hosts: string[], port: number, warn: (line: string) => void = console.warn): Promise<FastifyInstance[]> {
  const bus = deps.bus ?? new EventBus();
  const apps: FastifyInstance[] = [];
  const skipped: string[] = [];
  try {
    for (const host of hosts) {
      const app = buildApp({ ...deps, bus });
      try {
        await app.listen({ host, port });
      } catch (err) {
        // The Tailscale address does not exist while Tailscale is off. That must not take the whole core down:
        // keep serving on the other addresses (normally 127.0.0.1) and say which one was skipped.
        if ((err as NodeJS.ErrnoException).code !== "EADDRNOTAVAIL") throw err;
        await app.close();
        skipped.push(host);
        continue;
      }
      apps.push(app);
    }
    if (apps.length === 0) throw new Error(`none of the addresses in API_BIND_HOSTS is available (${skipped.join(", ")})`);
  } catch (err) {
    await Promise.all(apps.map((a) => a.close()));
    throw err;
  }
  for (const host of skipped) warn(`address ${host} is not available on this computer (is Tailscale running?): skipped, still listening on the others`);
  return apps;
}
