import { z } from "zod";

const required = (name: string) => z.string({ error: `Missing required env var ${name}` }).min(1, `Env var ${name} must not be empty`);
const positiveInt = (name: string) =>
  z.coerce.number({ error: `Env var ${name} must be a number` }).int(`Env var ${name} must be an integer`).positive(`Env var ${name} must be positive`);

const schema = z.object({
  GREEN_API_URL: required("GREEN_API_URL"),
  GREEN_API_INSTANCE_ID: required("GREEN_API_INSTANCE_ID"),
  GREEN_API_TOKEN: required("GREEN_API_TOKEN"),
  OWNER_PHONE: required("OWNER_PHONE").regex(/^\d{8,15}$/, "Env var OWNER_PHONE must be digits only, e.g. 972501234567"),
  POLL_INTERVAL_SECONDS: positiveInt("POLL_INTERVAL_SECONDS").default(5),
  TASK_TOKEN_CAP: positiveInt("TASK_TOKEN_CAP").default(200000),
  REMINDER_MINUTES: positiveInt("REMINDER_MINUTES").default(10),
  REMINDER_COUNT: positiveInt("REMINDER_COUNT").default(2),
  DB_PATH: required("DB_PATH").default("./data/core.db"),
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
