import { execFile } from "node:child_process";
import type { FastifyRequest } from "fastify";

/** Things that only make sense on the owner's own computer: opening folders and the native folder picker. */
export interface LocalActions {
  open(path: string, target: "folder" | "editor"): Promise<void>;
  /** Native "choose folder" dialog. Resolves to null when the owner cancels. */
  pickFolder(): Promise<string | null>;
}

export class LocalActionError extends Error {}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * True only for a request that comes from this computer itself. `tailscale serve` also reaches the core from
 * 127.0.0.1, but it adds forwarding headers, so those requests (the phone) are treated as remote.
 */
export function isLocalRequest(req: Pick<FastifyRequest, "ip" | "headers">): boolean {
  if (!LOOPBACK.has(req.ip)) return false;
  const h = req.headers;
  return !h["x-forwarded-for"] && !h["forwarded"] && !h["x-real-ip"] && !Object.keys(h).some((k) => k.startsWith("tailscale-"));
}

const run = (file: string, args: string[]) =>
  new Promise<string>((done, fail) => {
    execFile(file, args, { timeout: 120_000 }, (err, stdout) => (err ? fail(err) : done(stdout.trim())));
  });

/** Editors tried in order; the first one installed opens the folder. */
const MAC_EDITORS = ["Visual Studio Code", "Cursor", "Xcode"];

export const systemLocalActions: LocalActions = {
  async open(path, target) {
    if (process.platform === "darwin") {
      if (target === "folder") return void (await run("open", [path]));
      for (const app of MAC_EDITORS) {
        try {
          return void (await run("open", ["-a", app, path]));
        } catch {
          // not installed: try the next one
        }
      }
      throw new LocalActionError("לא נמצא עורך קוד מותקן (VS Code או Cursor).");
    }
    if (process.platform === "win32") return void (await run("explorer", [path]).catch(() => undefined)); // explorer exits 1 on success
    if (target === "editor") return void (await run("code", [path]).catch(() => { throw new LocalActionError("לא נמצא עורך קוד מותקן."); }));
    await run("xdg-open", [path]);
  },
  async pickFolder() {
    if (process.platform !== "darwin") throw new LocalActionError("בחירת תיקייה בלחיצה נתמכת כרגע רק ב-Mac.");
    try {
      const out = await run("osascript", ["-e", 'POSIX path of (choose folder with prompt "בחר את תיקיית הפרויקט")']);
      return out.replace(/\/$/, "") || null;
    } catch (err) {
      if (/-128|User canceled/i.test(String((err as Error).message))) return null;
      throw err;
    }
  },
};
