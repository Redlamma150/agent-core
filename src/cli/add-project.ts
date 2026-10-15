import "dotenv/config";
import { registerProject } from "../core/projects.js";
import { openDb } from "../db/index.js";

// Usage: npm run project:add -- <name> <absolute repo path> [context file, relative to the repo] [test command, quoted]
const [name, repoPath, contextFile, testCommand] = process.argv.slice(2);
if (!name || !repoPath) {
  console.error("usage: npm run project:add -- <name> <absolute repo path> [context file] [test command]");
  process.exit(1);
}
const db = openDb(process.env.DB_PATH || "./data/core.db");
try {
  const { id, warnings } = await registerProject(db, { name, repoPath, contextFile: contextFile || undefined, testCommand });
  console.log(`project "${name}" registered with id ${id}`);
  warnings.forEach((w) => console.warn(`warning: ${w}`));
} catch (err) {
  console.error(`error: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  db.close();
}
