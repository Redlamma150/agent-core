import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect, createServer as createTcpServer, type Socket } from "node:net";
import { extname, resolve } from "node:path";
import { MIME, resolveStatic } from "./screenshots.js";

/** A test environment that could not be started. The message is shown to the owner (Hebrew). */
export class PreviewError extends Error {}

export interface PreviewSpec {
  /** Static page: the folder to serve. Dev server: the task's worktree, where the command runs. */
  root: string;
  /** Run this instead of serving files (set per project by the owner). `{port}` is replaced by the port the app must listen on. */
  devCommand?: string | null;
  /** Path to open first, like "/chess/index.html". */
  path?: string;
}

export interface PreviewInfo {
  taskId: number;
  kind: "static" | "dev";
  port: number;
  token: string;
  /** The addresses it listens on: always the core's own bind addresses (localhost and Tailscale), never all interfaces. */
  hosts: string[];
  path: string;
  expiresAt: Date;
}

interface Running extends PreviewInfo {
  servers: Server[];
  child?: ChildProcess;
  timer?: NodeJS.Timeout;
  /** Upgraded connections (WebSockets): the HTTP server no longer tracks them, so they are closed here. */
  sockets: Set<Socket>;
}

const READY_TIMEOUT_MS = 120_000; // a dev command may install dependencies first
const COOKIE = (port: number) => `agent_preview_${port}`; // cookies are shared between ports of one host, so the name carries the port

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createTcpServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => ok(port));
    });
  });
}

function waitForPort(port: number, child: ChildProcess | undefined, output: () => string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  return new Promise((ok, fail) => {
    const attempt = () => {
      if (child && child.exitCode !== null) return fail(new PreviewError(`הפקודה נסגרה לפני שהאתר עלה.\n${output().slice(-600)}`));
      const s = connect(port, "127.0.0.1");
      s.once("connect", () => {
        s.destroy();
        ok();
      });
      s.once("error", () => {
        s.destroy();
        if (Date.now() > deadline) fail(new PreviewError(`האתר לא עלה תוך ${READY_TIMEOUT_MS / 1000} שניות.\n${output().slice(-600)}`));
        else setTimeout(attempt, 500);
      });
    };
    attempt();
  });
}

/**
 * Test environments for work that is not merged yet: the task's worktree served on its own port, so the owner can open
 * and try it from the computer or the phone before approving. A page of static files is served directly; a project with a
 * dev command gets that command run in the worktree and proxied. Every address needs the preview's secret (a link with it,
 * then a cookie), it listens only where the core itself listens, and it closes after a while without use.
 */
export class PreviewService {
  private running = new Map<number, Running>();
  private starting = new Map<number, Promise<PreviewInfo>>();

  constructor(private o: { hosts: string[]; idleMs?: number }) {
    if (o.hosts.some((h) => h === "0.0.0.0" || h === "::")) throw new Error("preview must never listen on all interfaces");
  }

  get(taskId: number): PreviewInfo | null {
    const r = this.running.get(taskId);
    return r ? this.info(r) : null;
  }

  /** Starts the environment for a task, or returns the one already running. */
  start(taskId: number, spec: PreviewSpec): Promise<PreviewInfo> {
    const existing = this.running.get(taskId);
    if (existing) return Promise.resolve(this.info(existing));
    let pending = this.starting.get(taskId);
    if (!pending) {
      pending = this.launch(taskId, spec).finally(() => this.starting.delete(taskId));
      this.starting.set(taskId, pending);
    }
    return pending;
  }

  async stop(taskId: number): Promise<void> {
    const r = this.running.get(taskId);
    if (!r) return;
    this.running.delete(taskId);
    clearTimeout(r.timer);
    r.sockets.forEach((s) => s.destroy());
    await Promise.all(r.servers.map((s) => new Promise<void>((ok) => { s.close(() => ok()); s.closeAllConnections?.(); })));
    if (r.child?.pid && r.child.exitCode === null) {
      try {
        process.kill(-r.child.pid, "SIGTERM"); // the whole group: dev servers start helpers
      } catch {
        // already gone
      }
      setTimeout(() => {
        try {
          if (r.child?.pid && r.child.exitCode === null) process.kill(-r.child.pid, "SIGKILL");
        } catch {
          // already gone
        }
      }, 3000).unref();
    }
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.running.keys()].map((id) => this.stop(id)));
  }

  private info(r: Running): PreviewInfo {
    const { taskId, kind, port, token, hosts, path, expiresAt } = r;
    return { taskId, kind, port, token, hosts, path, expiresAt };
  }

  private touch(r: Running): void {
    clearTimeout(r.timer);
    const idle = this.o.idleMs ?? 30 * 60_000;
    r.expiresAt = new Date(Date.now() + idle);
    r.timer = setTimeout(() => void this.stop(r.taskId), idle);
    r.timer.unref();
  }

  private async launch(taskId: number, spec: PreviewSpec): Promise<PreviewInfo> {
    const token = randomBytes(24).toString("hex");
    let devPort = 0;
    let child: ChildProcess | undefined;
    let tail = "";
    if (spec.devCommand) {
      devPort = await freePort();
      const env = { PATH: `${process.env.PATH ?? ""}:/opt/homebrew/bin:/usr/local/bin`, HOME: process.env.HOME, LANG: "en_US.UTF-8", PORT: String(devPort), BROWSER: "none", NODE_ENV: "development" };
      // The command comes from the owner's own project settings (set from the computer only), so it runs in a shell like in their terminal.
      child = spawn("/bin/sh", ["-c", spec.devCommand.replaceAll("{port}", String(devPort))], { cwd: spec.root, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      const keep = (d: Buffer) => (tail = (tail + d.toString()).slice(-2000));
      child.stdout?.on("data", keep);
      child.stderr?.on("data", keep);
      child.on("error", (err) => (tail += String(err)));
    }
    const kill = () => child?.pid && process.kill(-child.pid, "SIGTERM");
    try {
      if (child) await waitForPort(devPort, child, () => tail);
      const run: Running = { taskId, kind: child ? "dev" : "static", port: 0, token, hosts: [], path: spec.path ?? "/", expiresAt: new Date(), servers: [], sockets: new Set(), child };
      const handler = child ? this.proxyHandler(run, devPort) : this.staticHandler(run, spec.root);
      // One server per address on the same port: the first picks it, the others follow.
      for (const host of this.o.hosts) {
        const server = createServer(handler);
        if (child) server.on("upgrade", (req, socket, head) => this.upgrade(run, devPort, req, socket as Socket, head));
        try {
          await new Promise<void>((ok, fail) => {
            server.once("error", fail);
            server.listen(run.port, host, () => ok());
          });
        } catch (err) {
          if (run.servers.length === 0) throw new PreviewError(`לא הצלחתי לפתוח פורט לתצוגה: ${(err as Error).message}`);
          continue; // an address that is not available right now (for example Tailscale is down) is skipped
        }
        run.port = (server.address() as { port: number }).port;
        run.servers.push(server);
        run.hosts.push(host);
      }
      this.running.set(taskId, run);
      this.touch(run);
      return this.info(run);
    } catch (err) {
      try {
        kill();
      } catch {
        // not running
      }
      throw err;
    }
  }

  /** The secret from the link (and then the cookie) must be right, otherwise nothing is served. */
  private authorize(run: Running, req: IncomingMessage, res?: ServerResponse): boolean {
    const url = new URL(req.url ?? "/", "http://x");
    const given = url.searchParams.get("t");
    if (given && same(given, run.token)) {
      if (res) {
        url.searchParams.delete("t");
        res.writeHead(302, { location: url.pathname + url.search, "set-cookie": `${COOKIE(run.port)}=${run.token}; Path=/; HttpOnly; SameSite=Lax` }).end();
      }
      return false; // handled as a redirect
    }
    const cookie = (req.headers.cookie ?? "").split(";").map((c) => c.trim()).find((c) => c.startsWith(`${COOKIE(run.port)}=`));
    if (cookie && same(cookie.slice(COOKIE(run.port).length + 1), run.token)) return true;
    res?.writeHead(401, { "content-type": "text/plain; charset=utf-8" }).end("הקישור הזה לא תקף. פתח אותו מחדש מהאפליקציה.");
    return false;
  }

  private staticHandler(run: Running, root: string) {
    const base = resolve(root);
    return (req: IncomingMessage, res: ServerResponse) => {
      if (!this.authorize(run, req, res)) return;
      this.touch(run);
      const found = resolveStatic(base, req.url ?? "/");
      // Web files only, and nothing hidden: the page is shown, the project's other files are not browsable.
      const ext = extname(found.status === 200 ? found.file : "").toLowerCase();
      if (found.status !== 200 || !(ext in MIME) || /(^|\/)\./.test(found.file.slice(base.length))) return void res.writeHead(found.status === 200 ? 403 : found.status).end();
      res.writeHead(200, { "content-type": MIME[ext]!, "cache-control": "no-store" });
      res.end(readFileSync(found.file));
    };
  }

  private proxyHandler(run: Running, devPort: number) {
    return (req: IncomingMessage, res: ServerResponse) => {
      if (!this.authorize(run, req, res)) return;
      this.touch(run);
      const headers = { ...req.headers, host: `127.0.0.1:${devPort}` };
      delete headers.cookie; // our own secret is not the dev server's business
      const up = httpRequest({ host: "127.0.0.1", port: devPort, method: req.method, path: req.url, headers }, (back) => {
        res.writeHead(back.statusCode ?? 502, back.headers);
        back.pipe(res);
      });
      up.on("error", () => res.headersSent || res.writeHead(502, { "content-type": "text/plain; charset=utf-8" }).end("שרת הפיתוח לא עונה."));
      req.pipe(up);
    };
  }

  /** WebSockets (hot reload) pass through, after the same check. */
  private upgrade(run: Running, devPort: number, req: IncomingMessage, socket: Socket, head: Buffer): void {
    if (!this.authorize(run, req)) return void socket.destroy();
    this.touch(run);
    const up = connect(devPort, "127.0.0.1", () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`, ...Object.entries(req.headers).filter(([k]) => k !== "cookie").map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`), "", ""];
      up.write(lines.join("\r\n"));
      if (head.length) up.write(head);
      socket.pipe(up).pipe(socket);
    });
    run.sockets.add(socket).add(up);
    const done = () => { run.sockets.delete(socket); run.sockets.delete(up); };
    up.on("close", done);
    socket.on("close", done);
    up.on("error", () => socket.destroy());
    socket.on("error", () => up.destroy());
  }
}
