import { execFile } from "node:child_process";

export interface VerifyResult {
  passed: boolean;
  /** One line for the owner, in Hebrew. On failure it ends with the tail of the output. */
  summary: string;
}

const TIMEOUT_MS = 5 * 60_000;
const MAX_TAIL = 1500;

/**
 * Runs the project's own test command inside the task's worktree, before the owner is asked to approve.
 * No shell is involved (the command is split on spaces) and the child gets a minimal environment, so none of
 * the core's secrets (.env values, tokens) are visible to the project's tests.
 */
export function runTests(command: string, cwd: string): Promise<VerifyResult> {
  const [file, ...args] = command.trim().split(/\s+/);
  if (!file) return Promise.resolve({ passed: true, summary: "" });
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, CI: "1", NODE_ENV: "test", LANG: "en_US.UTF-8" };
  return new Promise((done) => {
    execFile(file, args, { cwd, env, timeout: TIMEOUT_MS, maxBuffer: 5_000_000 }, (err, stdout, stderr) => {
      if (!err) return done({ passed: true, summary: "הבדיקות של הפרויקט עברו" });
      const tail = `${stdout}\n${stderr}`.trim().slice(-MAX_TAIL);
      const why = err.killed ? "חרגו מהזמן המותר" : `נכשלו${typeof err.code === "number" ? ` (קוד ${err.code})` : ""}`;
      done({ passed: false, summary: `הבדיקות של הפרויקט ${why}\n${tail}` });
    });
  });
}
