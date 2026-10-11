import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";

const valid = {
  API_BIND_HOSTS: "127.0.0.1,100.64.0.7",
  APP_ACCESS_TOKEN: "a".repeat(40),
  VAPID_PUBLIC_KEY: "pub",
  VAPID_PRIVATE_KEY: "priv",
  VAPID_SUBJECT: "mailto:me@example.com",
};

describe("loadConfig", () => {
  it("applies defaults and splits bind hosts", () => {
    const c = loadConfig(valid);
    expect(c.API_PORT).toBe(8787);
    expect(c.API_BIND_HOSTS).toEqual(["127.0.0.1", "100.64.0.7"]);
    expect(c.TASK_TOKEN_CAP).toBe(200000);
    expect(c.DB_PATH).toBe("./data/core.db");
  });

  it("names every missing variable", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    try {
      loadConfig({});
    } catch (e) {
      const m = (e as Error).message;
      for (const n of ["API_BIND_HOSTS", "APP_ACCESS_TOKEN", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"]) expect(m).toContain(n);
    }
  });

  it("treats empty values as missing", () => {
    expect(() => loadConfig({ ...valid, APP_ACCESS_TOKEN: "" })).toThrow(/APP_ACCESS_TOKEN/);
  });

  it("rejects wildcard and non-IP bind hosts", () => {
    expect(() => loadConfig({ ...valid, API_BIND_HOSTS: "127.0.0.1,0.0.0.0" })).toThrow(/0\.0\.0\.0/);
    expect(() => loadConfig({ ...valid, API_BIND_HOSTS: "::" })).toThrow(/API_BIND_HOSTS/);
    expect(() => loadConfig({ ...valid, API_BIND_HOSTS: "127.0.0.1,100.x.y.z" })).toThrow(/100\.x\.y\.z/);
  });

  it("rejects a short access token and bad numbers", () => {
    expect(() => loadConfig({ ...valid, APP_ACCESS_TOKEN: "short" })).toThrow(/APP_ACCESS_TOKEN/);
    expect(() => loadConfig({ ...valid, TASK_TOKEN_CAP: "abc" })).toThrow(/TASK_TOKEN_CAP/);
    expect(() => loadConfig({ ...valid, API_PORT: "70000" })).toThrow(/API_PORT/);
  });

  it("refuses ANTHROPIC_API_KEY", () => {
    expect(() => loadConfig({ ...valid, ANTHROPIC_API_KEY: "x" })).toThrow(/ANTHROPIC_API_KEY/);
  });
});
