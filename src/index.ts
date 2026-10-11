import "dotenv/config";
import { startServers } from "./api/server.js";
import { EventBus } from "./api/events.js";
import { loadConfig } from "./config.js";
import { ApprovalService } from "./core/approvals.js";
import { TaskService } from "./core/tasks.js";
import { openDb } from "./db/index.js";

const config = loadConfig();
const db = openDb(config.DB_PATH);
const bus = new EventBus();
const tasks = new TaskService(db, bus);
const approvals = new ApprovalService(db, tasks, { reminderMinutes: config.REMINDER_MINUTES, reminderCount: config.REMINDER_COUNT }, bus);

const resumable = tasks.resumable();
if (resumable.length > 0) console.log(`resuming ${resumable.length} unfinished task(s): ${resumable.map((t) => `#${t.id} (${t.status})`).join(", ")}`);

const servers = await startServers({ db, accessToken: config.APP_ACCESS_TOKEN, tasks, approvals, bus, logger: true }, config.API_BIND_HOSTS, config.API_PORT);

// Reminders go out over SSE for now; Web Push delivery is wired up in M4.
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
