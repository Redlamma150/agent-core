import "dotenv/config";
import { loadConfig } from "./config.js";
import { openDb } from "./db/index.js";
import { createHandlers } from "./channel/handlers.js";
import { GreenApiClient, pollLoop } from "./channel/whatsapp.js";

const config = loadConfig();
const db = openDb(config.DB_PATH);

const client = new GreenApiClient({
  apiUrl: config.GREEN_API_URL,
  instanceId: config.GREEN_API_INSTANCE_ID,
  token: config.GREEN_API_TOKEN,
  ownerPhone: config.OWNER_PHONE,
  receiveTimeoutSeconds: config.POLL_INTERVAL_SECONDS,
});

const abort = new AbortController();
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => abort.abort());

console.log(`agent-core running (db: ${config.DB_PATH})`);
await pollLoop(client, config.OWNER_PHONE, createHandlers(db), abort.signal);
db.close();
