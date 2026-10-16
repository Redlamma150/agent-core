import { isIP } from "node:net";
import { z } from "zod";

const required = (name: string) => z.string({ error: `Missing required env var ${name}` }).min(1, `Env var ${name} must not be empty`);
const positiveInt = (name: string) =>
  z.coerce.number({ error: `Env var ${name} must be a number` }).int(`Env var ${name} must be an integer`).positive(`Env var ${name} must be positive`);

const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "0:0:0:0:0:0:0:0"]);

const bindHosts = required("API_BIND_HOSTS").transform((value, ctx) => {
  const hosts = value.split(",").map((h) => h.trim()).filter(Boolean);
  for (const h of hosts) {
    if (WILDCARD_HOSTS.has(h)) {
      ctx.addIssue({ code: "custom", message: `Env var API_BIND_HOSTS must never contain ${h} (listen on localhost and the Tailscale IP only)` });
    } else if (!isIP(h)) {
      ctx.addIssue({ code: "custom", message: `Env var API_BIND_HOSTS contains "${h}", which is not an IP address (get the Tailscale one with: tailscale ip -4)` });
    }
  }
  if (hosts.length === 0) ctx.addIssue({ code: "custom", message: "Env var API_BIND_HOSTS must list at least one address" });
  return hosts;
});

const schema = z.object({
  API_PORT: positiveInt("API_PORT").max(65535, "Env var API_PORT must be at most 65535").default(8787),
  API_BIND_HOSTS: bindHosts,
  APP_ACCESS_TOKEN: required("APP_ACCESS_TOKEN").min(32, "Env var APP_ACCESS_TOKEN must be at least 32 characters (e.g. openssl rand -hex 32)"),
  VAPID_PUBLIC_KEY: required("VAPID_PUBLIC_KEY"),
  VAPID_PRIVATE_KEY: required("VAPID_PRIVATE_KEY"),
  VAPID_SUBJECT: required("VAPID_SUBJECT").regex(/^(mailto:|https:\/\/)/, "Env var VAPID_SUBJECT must start with mailto: or https://"),
  TASK_TOKEN_CAP: positiveInt("TASK_TOKEN_CAP").default(200000),
  REMINDER_MINUTES: positiveInt("REMINDER_MINUTES").default(10),
  REMINDER_COUNT: positiveInt("REMINDER_COUNT").default(2),
  DB_PATH: required("DB_PATH").default("./data/core.db"),
  /** Longest a single task may run before it is parked as blocked, so one stuck task cannot hold up the queue. */
  TASK_TIMEOUT_MINUTES: positiveInt("TASK_TIMEOUT_MINUTES").default(45),
  STATIC_DIR: required("STATIC_DIR").default("./app/dist"),
  /** Take before and after screenshots of the page a task changed, for the approval screen. */
  SCREENSHOTS: z.enum(["true", "false"], { error: "Env var SCREENSHOTS must be true or false" }).default("true"),
  /** Chrome or Chromium executable for the screenshots. Empty: the installed Google Chrome is used. */
  BROWSER_PATH: z.string().optional(),
  /** Keep the Mac from going to sleep while the core runs (macOS only), so the phone can always reach it. */
  KEEP_AWAKE: z.enum(["true", "false"], { error: "Env var KEEP_AWAKE must be true or false" }).default("true"),
});

export type Config = z.infer<typeof schema>;

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Empty values (as in .env.example) count as missing so defaults apply or an error is raised.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ""));
  if (cleaned.ANTHROPIC_API_KEY) {
    throw new ConfigError("ANTHROPIC_API_KEY must not be set: agents run on the Claude subscription, not the API");
  }
  const result = schema.safeParse(cleaned);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `- ${i.message}`);
    throw new ConfigError(`Invalid configuration:\n${lines.join("\n")}`);
  }
  return result.data;
}
