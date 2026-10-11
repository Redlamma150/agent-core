import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/api/server.js";
import { openDb } from "../src/db/index.js";
import { services } from "./api.test.js";

const TOKEN = "t".repeat(40);
let dir: string;
let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "app-"));
  dir = join(root, "public"); // served directory; secret.txt sits one level above it
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "index.html"), "<html>app</html>");
  writeFileSync(join(dir, "sw.js"), "// sw");
  writeFileSync(join(dir, "assets", "a.js"), "// a");
  writeFileSync(join(root, "secret.txt"), "top secret");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const app = (staticDir?: string) => {
  const db = openDb(":memory:");
  return buildApp({ db, accessToken: TOKEN, staticDir, ...services(db) });
};

describe("static app", () => {
  it("serves the app shell without a token", async () => {
    const a = app(dir);
    const root = await a.inject({ url: "/" });
    expect(root.statusCode).toBe(200);
    expect(root.body).toBe("<html>app</html>");
    expect((await a.inject({ url: "/assets/a.js" })).statusCode).toBe(200);
  });

  it("revalidates the service worker and entry page but not hashed assets", async () => {
    const a = app(dir);
    expect((await a.inject({ url: "/sw.js" })).headers["cache-control"]).toBe("no-cache");
    expect((await a.inject({ url: "/assets/a.js" })).headers["cache-control"]).not.toBe("no-cache");
    expect((await a.inject({ url: "/sw.js" })).headers["x-content-type-options"]).toBe("nosniff");
  });

  it("keeps every API route behind the token even with static serving on", async () => {
    const a = app(dir);
    for (const url of ["/tasks", "/approvals", "/usage", "/events", "/push/public-key"]) {
      expect((await a.inject({ url })).statusCode, url).toBe(401);
    }
  });

  it("does not let paths escape the app directory", async () => {
    const a = app(dir);
    for (const url of ["/../secret.txt", "/%2e%2e/secret.txt", "/assets/../../secret.txt", "/..%2fsecret.txt"]) {
      const res = await a.inject({ url });
      expect(res.statusCode, url).not.toBe(200);
      expect(res.body).not.toContain("top secret");
    }
  });

  it("is simply absent when the app has not been built", async () => {
    const a = app(join(dir, "missing"));
    expect((await a.inject({ url: "/" })).statusCode).toBe(404);
    expect((await a.inject({ url: "/usage", headers: { authorization: `Bearer ${TOKEN}` } })).statusCode).toBe(200);
  });
});
