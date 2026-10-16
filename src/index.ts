import "dotenv/config";
import { startServers } from "./api/server.js";
import { EventBus } from "./api/events.js";
import { attachPush, createWebPushSender, PushService } from "./api/push.js";
import { loadConfig } from "./config.js";
import { AgentRunner, protectedPathsFor } from "./agents/runner.js";
import { ActivityService } from "./core/activity.js";
import { systemLocalActions } from "./core/local.js";
import { InsightService } from "./core/insights.js";
import { MediaService } from "./core/media.js";
import { SettingsService } from "./core/settings.js";
import { ApprovalService } from "./core/approvals.js";
import { BudgetService } from "./core/budget.js";
import { GitService } from "./core/git.js";
import { keepAwake } from "./core/awake.js";
import { OperatorService } from "./core/operator.js";
import { Pipeline } from "./core/pipeline.js";
import { playwrightLauncher, ScreenshotService } from "./core/screenshots.js";
import { dirname, join } from "node:path";
import { TaskService } from "./core/tasks.js";
import { openDb } from "./db/index.js";

const config = loadConfig();
if (config.KEEP_AWAKE === "true" && keepAwake()) console.log("keeping the computer awake while the core runs (KEEP_AWAKE=false to turn this off)");
const db = openDb(config.DB_PATH);
const bus = new EventBus();
const tasks = new TaskService(db, bus);
const activity = new ActivityService(db, bus);
const purged = tasks.purgeTrashed();
if (purged > 0) console.log(`removed ${purged} task(s) that sat in the trash for over 30 days`);
const approvals = new ApprovalService(db, tasks, { reminderMinutes: config.REMINDER_MINUTES, reminderCount: config.REMINDER_COUNT }, bus);

const push = new PushService(
  db,
  createWebPushSender({ subject: config.VAPID_SUBJECT, publicKey: config.VAPID_PUBLIC_KEY, privateKey: config.VAPID_PRIVATE_KEY }),
);
attachPush(bus, push);

const settings = new SettingsService(db);
const insights = new InsightService(db, settings);
const media = new MediaService(db, join(dirname(config.DB_PATH), "uploads"));
const budget = new BudgetService(tasks, config.TASK_TOKEN_CAP, bus);
const runner = new AgentRunner(db, tasks, undefined, activity, protectedPathsFor(config.DB_PATH));
const pipeline = new Pipeline({ db, tasks, approvals, runner, budget, git: new GitService(join(dirname(config.DB_PATH), "worktrees")), activity, media, settings, screenshots: config.SCREENSHOTS === "true" ? new ScreenshotService(media, playwrightLauncher(config.BROWSER_PATH)) : undefined, timeoutMs: config.TASK_TIMEOUT_MINUTES * 60_000 });
const operator = new OperatorService({ db, tasks, driver: pipeline, runner }, join(dirname(config.DB_PATH), "operator"));
const resumed = pipeline.resume();
if (resumed > 0) console.log(`resuming ${resumed} unfinished task(s)`);

const servers = await startServers({ db, accessToken: config.APP_ACCESS_TOKEN, tasks, approvals, driver: pipeline, activity, media, insights, settings, local: systemLocalActions, operator, push, vapidPublicKey: config.VAPID_PUBLIC_KEY, staticDir: config.STATIC_DIR, bus, logger: true }, config.API_BIND_HOSTS, config.API_PORT);

// Reminders are published on the bus: SSE clients see them live and attachPush forwards them as Web Push.
const reminderTimer = setInterval(() => {
  approvals
    .sendDueReminders((a, n) => bus.publish({ type: "reminder", data: { approval_id: a.id, task_id: a.task_id, number: n } }))
    .catch((err: Error) => console.error(`reminder error: ${err.message}`));
}, 30_000);

const shutdown = async () => {
  clearInterval(reminderTimer);
  await Promise.all(servers.map((s) => s.close()));
  db.close();
  process.exit(0);
};
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, shutdown);
