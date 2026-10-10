import "dotenv/config";
import { loadConfig } from "./config.js";
import { openDb } from "./db/index.js";

const config = loadConfig();
openDb(config.DB_PATH);
console.log(`agent-core ready (db: ${config.DB_PATH})`);
