import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/api/server.js";
import { PreviewError, PreviewService } from "../src/core/preview.js";
import { openDb } from "../src/db/index.js";
import { services } from "./api.test.js";

const dirs: string[] = [];
const svcs: PreviewService[] = [];
afterEach(async () => {
  await Promise.all(svcs.splice(0).map((s) => s.stopAll()));
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "preview-test-"));
  dirs.push(d);
  return d;
};
const write = (root: string, rel: string, text: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const service = (idleMs?: number) => {
  const s = new PreviewService({ hosts: ["127.0.0.1"], idleMs });
  svcs.push(s);
  return s;
};
const base = (p: { port: number }) => `http://127.0.0.1:${p.port}`;
/** Opens the secret link like a browser would, and returns the cookie it sets. */
async function login(p: { port: number; token: string }): Promise<string> {
  const res = await fetch(`${base(p)}/?t=${p.token}`, { redirect: "manual" });
  expect(res.status).toBe(302);
  return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
}

describe("static test environment", () => {
  it("needs the secret link, then a cookie, and only shows web files", async () => {
    const root = tmp();
    write(root, "index.html", "<h1>hi</h1>");
    write(root, "app.js", "console.log(1)");
    write(root, "server.py", "secret = 1");
    write(root, ".env", "TOKEN=1");
    write(root, "sub/.hidden.html", "x");
    const p = await service().start(1, { root });
    expect(p).toMatchObject({ kind: "static", hosts: ["127.0.0.1"], path: "/" });

    expect((await fetch(`${base(p)}/`)).status).toBe(401); // no secret
    expect((await fetch(`${base(p)}/?t=wrong`)).status).toBe(401);
    expect((await fetch(`${base(p)}/`, { headers: { cookie: "agent_preview_1=x" } })).status).toBe(401);

    const cookie = await login(p);
    const get = (path: string) => fetch(`${base(p)}${path}`, { headers: { cookie } });
    const page = await get("/");
    expect(page.status).toBe(200);
    expect(await page.text()).toBe("<h1>hi</h1>");
    expect((await get("/app.js")).status).toBe(200);
    expect((await get("/server.py")).status).toBe(403); // not a web file
    expect((await get("/.env")).status).toBe(403);
    expect((await get("/sub/.hidden.html")).status).toBe(403);
    expect((await get("/..%2f..%2fetc/passwd")).status).not.toBe(200);
    expect((await get("/missing.css")).status).toBe(404);
  });

  it("is idempotent, gives each task its own secret and port, and stop closes the port", async () => {
    const a = tmp();
    const b = tmp();
    write(a, "index.html", "a");
    write(b, "index.html", "b");
    const s = service();
    const pa = await s.start(1, { root: a });
    expect(await s.start(1, { root: a })).toEqual(pa); // same one, not a second server
    const pb = await s.start(2, { root: b });
    expect(pb.port).not.toBe(pa.port);
    expect(pb.token).not.toBe(pa.token);
    // one task's cookie does not open the other's page
    const cookieA = await login(pa);
    expect((await fetch(`${base(pb)}/`, { headers: { cookie: cookieA } })).status).toBe(401);

    expect(s.get(1)).not.toBeNull();
    await s.stop(1);
    expect(s.get(1)).toBeNull();
    await expect(fetch(`${base(pa)}/?t=${pa.token}`)).rejects.toThrow();
  });

  it("closes by itself after a while without use, and use keeps it open", async () => {
    const root = tmp();
    write(root, "index.html", "x");
    const s = service(400);
    const p = await s.start(1, { root });
    const cookie = await login(p);
    await new Promise((r) => setTimeout(r, 250));
    await fetch(`${base(p)}/`, { headers: { cookie } }); // use
    await new Promise((r) => setTimeout(r, 250));
    expect(s.get(1)).not.toBeNull(); // would have expired at 400ms without the request
    await new Promise((r) => setTimeout(r, 600));
    expect(s.get(1)).toBeNull();
  });

  it("refuses to listen on all interfaces", () => {
    expect(() => new PreviewService({ hosts: ["0.0.0.0"] })).toThrow(/all interfaces/);
    expect(() => new PreviewService({ hosts: ["127.0.0.1", "::"] })).toThrow(/all interfaces/);
  });
});

describe("dev server test environment", () => {
  const server = `node -e "
    const http = require('http');
    const s = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ url: req.url, host: req.headers.host, cookie: req.headers.cookie || null, port: process.env.PORT, leak: process.env.APP_ACCESS_TOKEN || null })); });
    s.on('upgrade', (req, socket) => { socket.write('HTTP/1.1 101 Switching Protocols\\\\r\\\\nUpgrade: websocket\\\\r\\\\nConnection: Upgrade\\\\r\\\\n\\\\r\\\\n'); socket.on('data', (d) => socket.write('echo:' + d)); });
    s.listen({port}, '127.0.0.1');
  "`;

  it("runs the project's command in the worktree and proxies to it behind the same secret", async () => {
    process.env.APP_ACCESS_TOKEN = "core-secret";
    try {
      const root = tmp();
      const p = await service().start(1, { root, devCommand: server });
      expect(p.kind).toBe("dev");
      expect((await fetch(`${base(p)}/api/x`)).status).toBe(401); // the proxy is protected too

      const cookie = await login(p);
      const res = await (await fetch(`${base(p)}/api/x?y=1`, { headers: { cookie: `${cookie}; theme=dark` } })).json();
      expect(res.url).toBe("/api/x?y=1");
      expect(res.host).toMatch(/^127\.0\.0\.1:\d+$/);
      expect(res.host).not.toBe(`127.0.0.1:${p.port}`); // the dev server sees its own port
      expect(res.cookie).toBeNull(); // the preview's secret is not passed on
      expect(res.leak).toBeNull(); // nor are the core's secrets
      expect(String(res.port)).toBe(res.host.split(":")[1]); // {port} and PORT agree
    } finally {
      delete process.env.APP_ACCESS_TOKEN;
    }
  }, 30_000);

  it("passes websockets through after the same check", async () => {
    const p = await service().start(1, { root: tmp(), devCommand: server });
    const cookie = await login(p);
    const talk = (cookieHeader: string) =>
      new Promise<string>((done) => {
        const s = connect(p.port, "127.0.0.1", () => s.write(`GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: abc\r\nSec-WebSocket-Version: 13\r\n${cookieHeader}\r\n`));
        let got = "";
        s.on("data", (d) => {
          got += d.toString();
          if (got.includes("101") && !got.includes("echo:")) s.write("ping");
          if (got.includes("echo:ping")) s.destroy();
        });
        s.on("close", () => done(got));
        s.on("error", () => done(got));
        setTimeout(() => { s.destroy(); done(got); }, 3000);
      });
    expect(await talk(`Cookie: ${cookie}\r\n`)).toContain("echo:ping");
    expect(await talk("")).not.toContain("101"); // no cookie: refused
  }, 30_000);

  it("explains what happened when the command dies before the site is up", async () => {
    await expect(service().start(1, { root: tmp(), devCommand: 'echo "Missing script: dev" >&2; exit 1' })).rejects.toThrow(/Missing script: dev/);
    await expect(service().start(2, { root: tmp(), devCommand: 'exit 0' })).rejects.toThrow(PreviewError);
  }, 30_000);

  it("stop ends the dev server too", async () => {
    const s = service();
    const p = await s.start(1, { root: tmp(), devCommand: server });
    const cookie = await login(p);
    const info = await (await fetch(`${base(p)}/`, { headers: { cookie } })).json();
    await s.stop(1);
    await new Promise((r) => setTimeout(r, 4500)); // SIGTERM is enough for node; the SIGKILL backstop is 3s
    await expect(fetch(`http://127.0.0.1:${info.port}/`)).rejects.toThrow();
  }, 30_000);
});

describe("preview API", () => {
  const TOKEN = "t".repeat(40);
  const auth = { authorization: `Bearer ${TOKEN}` };

  function appWith(worktree: string | null, devCommand: string | null = null) {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO projects (name, repo_path, dev_command) VALUES ('p', '/r', ?)").run(devCommand);
    db.prepare("INSERT INTO tasks (project_id, description) VALUES (1, 'first')").run();
    const base = services(db);
    const driver = { ...base.driver, locate: () => (worktree ? { path: worktree, kind: "worktree" as const, exists: true } : { path: "/r", kind: "project" as const, exists: true }) };
    const preview = service();
    const app = buildApp({ db, accessToken: TOKEN, ...base, driver, preview, local: { open: async () => undefined, pickFolder: async () => null } });
    return { db, app, preview, send: (method: "GET" | "POST" | "DELETE" | "PATCH", url: string, payload?: object, remote = false) => app.inject({ method, url, headers: auth, payload, remoteAddress: "127.0.0.1", ...(remote ? { headers: { ...auth, "x-forwarded-for": "100.1.1.1" } } : {}) }) };
  }

  it("starts a test environment for the page a task changed, tells where to open it, and stops it", async () => {
    const root = tmp();
    write(root, "site/index.html", "<p>task page</p>");
    write(root, "site/style.css", "p{}");
    const t = appWith(root);
    t.db.prepare("INSERT INTO steps (task_id, agent, status, handoff) VALUES (1, 'system', 'files_changed', ?)").run(JSON.stringify([{ path: "site/index.html", status: "added", added: 1, removed: 0 }]));

    expect((await t.send("GET", "/tasks/1/preview")).json()).toEqual({ running: false });
    const started = (await t.send("POST", "/tasks/1/preview")).json();
    expect(started).toMatchObject({ running: true, kind: "static" });
    expect(started.urls).toHaveLength(1);
    expect(started.urls[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]{48}$/);
    expect(new Date(started.expires_at).getTime()).toBeGreaterThan(Date.now());

    const page = await fetch(started.urls[0]!, { redirect: "manual" });
    const cookie = (page.headers.get("set-cookie") ?? "").split(";")[0]!;
    const shown = await fetch(started.urls[0]!.split("?")[0]!, { headers: { cookie } });
    expect(await shown.text()).toBe("<p>task page</p>"); // served from the changed page's folder, so /style.css would resolve too
    expect((await t.send("GET", "/tasks/1/preview")).json()).toMatchObject({ running: true });
    expect((await t.send("POST", "/tasks/1/preview")).json().urls).toEqual(started.urls); // second tap: same link

    expect((await t.send("DELETE", "/tasks/1/preview")).statusCode).toBe(204);
    expect((await t.send("GET", "/tasks/1/preview")).json()).toEqual({ running: false });
  });

  it("explains when there is nothing to run", async () => {
    const empty = tmp();
    const none = appWith(null);
    const merged = await none.send("POST", "/tasks/1/preview");
    expect(merged.statusCode).toBe(422);
    expect(merged.json().message).toContain("אין עותק עבודה");

    const noPage = appWith(empty);
    const res = await noPage.send("POST", "/tasks/1/preview");
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: "preview_failed", message: expect.stringContaining("פקודת הרצה") });
    expect((await noPage.send("POST", "/tasks/99/preview")).statusCode).toBe(404);
  });

  it("uses the project's dev command when it has one", async () => {
    const t = appWith(tmp(), `node -e "require('http').createServer((q,r)=>r.end('dev')).listen({port},'127.0.0.1')"`);
    const started = (await t.send("POST", "/tasks/1/preview")).json();
    expect(started.kind).toBe("dev");
    expect(started.urls[0]).toMatch(/\/\?t=/);
  }, 30_000);

  it("the dev command can be set only from the computer itself", async () => {
    const t = appWith(null);
    expect((await t.send("PATCH", "/projects/1", { dev_command: "npm run dev -- --port {port}" })).json()).toMatchObject({ dev_command: "npm run dev -- --port {port}" });
    expect((await t.send("GET", "/projects")).json()[0]).toMatchObject({ dev_command: "npm run dev -- --port {port}" });
    const fromPhone = await t.send("PATCH", "/projects/1", { dev_command: "rm -rf /" }, true);
    expect(fromPhone.statusCode).toBe(403);
    expect((await t.send("GET", "/projects")).json()[0].dev_command).toBe("npm run dev -- --port {port}"); // unchanged
    expect((await t.send("PATCH", "/projects/1", { dev_command: null })).json().dev_command).toBeNull();
    expect((await t.send("PATCH", "/projects/9", { dev_command: "x" })).statusCode).toBe(404);
  });

  it("approving a task closes its test environment", async () => {
    const root = tmp();
    write(root, "index.html", "x");
    const t = appWith(root);
    await t.send("POST", "/tasks/1/preview");
    expect(t.preview.get(1)).not.toBeNull();
    t.db.prepare("UPDATE tasks SET status = 'planning' WHERE id = 1").run();
    const { approvals } = services(t.db);
    const a = approvals.request(1, "merge?");
    await t.send("POST", `/approvals/${a.id}`, { decision: "approve" });
    expect(t.preview.get(1)).toBeNull();
  });
});
