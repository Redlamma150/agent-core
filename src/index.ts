import "dotenv/config";
import { startServers } from "./api/server.js";
import { loadConfig } from "./config.js";
import { openDb } from "./db/index.js";

const config = loadConfig();
const db = openDb(config.DB_PATH);

const servers = await startServers({ db, accessToken: config.APP_ACCESS_TOKEN, logger: true }, config.API_BIND_HOSTS, config.API_PORT);

const shutdown = async () => {
  await Promise.all(servers.map((s) => s.close()));
  db.close();
  process.exit(0);
};
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, shutdown);
