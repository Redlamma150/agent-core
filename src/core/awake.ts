import { spawn, type ChildProcess } from "node:child_process";

type Spawn = (cmd: string, args: string[]) => Pick<ChildProcess, "unref" | "on">;

/**
 * Keeps the Mac from going to sleep while this process lives, using the built-in `caffeinate`:
 * -i blocks idle sleep, -s also blocks system sleep while on mains power, -w ties it to our process so it ends with us.
 * Closing the lid of a laptop still puts it to sleep (macOS does not allow that to be prevented without an external display).
 * Returns true when it was started; does nothing on other systems.
 */
export function keepAwake(pid = process.pid, platform: string = process.platform, run: Spawn = (c, a) => spawn(c, a, { stdio: "ignore" })): boolean {
  if (platform !== "darwin") return false;
  try {
    const child = run("caffeinate", ["-i", "-s", "-w", String(pid)]);
    child.on("error", () => undefined); // caffeinate missing: carry on without it
    child.unref();
    return true;
  } catch {
    return false;
  }
}
