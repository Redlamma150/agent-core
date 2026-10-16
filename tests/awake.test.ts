import { describe, expect, it } from "vitest";
import { keepAwake } from "../src/core/awake.js";
import { loadConfig } from "../src/config.js";

const fakeSpawn = () => {
  const calls: { cmd: string; args: string[] }[] = [];
  const run = (cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    return { unref: () => undefined, on: () => ({}) as never };
  };
  return { calls, run };
};

describe("keepAwake", () => {
  it("runs caffeinate tied to our process on macOS", () => {
    const s = fakeSpawn();
    expect(keepAwake(4242, "darwin", s.run)).toBe(true);
    expect(s.calls).toEqual([{ cmd: "caffeinate", args: ["-i", "-s", "-w", "4242"] }]);
  });
  it("does nothing on other systems, and survives a failing spawn", () => {
    const s = fakeSpawn();
    expect(keepAwake(1, "linux", s.run)).toBe(false);
    expect(s.calls).toHaveLength(0);
    expect(keepAwake(1, "darwin", () => { throw new Error("no caffeinate"); })).toBe(false);
  });
  it("has a 45 minute task time limit by default and rejects nonsense", () => {
    const base = { API_BIND_HOSTS: "127.0.0.1", APP_ACCESS_TOKEN: "a".repeat(32), VAPID_PUBLIC_KEY: "k", VAPID_PRIVATE_KEY: "k", VAPID_SUBJECT: "mailto:a@b.c", DB_PATH: "./x.db" };
    expect(loadConfig(base).TASK_TIMEOUT_MINUTES).toBe(45);
    expect(loadConfig({ ...base, TASK_TIMEOUT_MINUTES: "90" }).TASK_TIMEOUT_MINUTES).toBe(90);
    expect(() => loadConfig({ ...base, TASK_TIMEOUT_MINUTES: "0" })).toThrow(/TASK_TIMEOUT_MINUTES/);
  });
  it("is on by default and can be turned off in the config", () => {
    const base = { API_BIND_HOSTS: "127.0.0.1", APP_ACCESS_TOKEN: "a".repeat(32), VAPID_PUBLIC_KEY: "k", VAPID_PRIVATE_KEY: "k", VAPID_SUBJECT: "mailto:a@b.c", DB_PATH: "./x.db" };
    expect(loadConfig(base).KEEP_AWAKE).toBe("true");
    expect(loadConfig({ ...base, KEEP_AWAKE: "false" }).KEEP_AWAKE).toBe("false");
    expect(() => loadConfig({ ...base, KEEP_AWAKE: "maybe" })).toThrow(/KEEP_AWAKE/);
  });
});
