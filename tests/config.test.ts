import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";

const valid = {
  GREEN_API_URL: "https://api.green-api.com",
  GREEN_API_INSTANCE_ID: "1101",
  GREEN_API_TOKEN: "tok",
  OWNER_PHONE: "972501234567",
};

describe("loadConfig", () => {
  it("applies defaults", () => {
    const c = loadConfig(valid);
    expect(c.POLL_INTERVAL_SECONDS).toBe(5);
    expect(c.TASK_TOKEN_CAP).toBe(200000);
    expect(c.DB_PATH).toBe("./data/core.db");
  });

  it("names every missing variable", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    try {
      loadConfig({});
    } catch (e) {
      const m = (e as Error).message;
      for (const n of ["GREEN_API_URL", "GREEN_API_INSTANCE_ID", "GREEN_API_TOKEN", "OWNER_PHONE"]) expect(m).toContain(n);
    }
  });

  it("treats empty values as missing", () => {
    expect(() => loadConfig({ ...valid, GREEN_API_TOKEN: "" })).toThrow(/GREEN_API_TOKEN/);
  });

  it("rejects a malformed phone and bad numbers", () => {
    expect(() => loadConfig({ ...valid, OWNER_PHONE: "+972-50" })).toThrow(/OWNER_PHONE/);
    expect(() => loadConfig({ ...valid, TASK_TOKEN_CAP: "abc" })).toThrow(/TASK_TOKEN_CAP/);
  });

  it("refuses ANTHROPIC_API_KEY", () => {
    expect(() => loadConfig({ ...valid, ANTHROPIC_API_KEY: "x" })).toThrow(/ANTHROPIC_API_KEY/);
  });
});
