import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Roles that have a prompt template. */
export type TemplateRole = "planner" | "builder" | "operator";

export function loadTemplate(role: TemplateRole): string {
  return readFileSync(fileURLToPath(new URL(`./templates/${role}.md`, import.meta.url)), "utf8");
}

/** Read-only tools for the planner; the builder also edits and runs the project's checks. */
export const PLANNER_TOOLS = ["Read", "Grep", "Glob"];
export const BUILDER_TOOLS = ["Read", "Grep", "Glob", "Edit", "Write", "Bash"];
/**
 * Everything not listed is denied (permission mode dontAsk). Bash is limited to running the project's own checks
 * and read-only git; commits and merges are done by the core, never by the agent.
 */
export const BUILDER_ALLOWED = [
  ...BUILDER_TOOLS.filter((t) => t !== "Bash"),
  "Bash(npm test:*)",
  "Bash(npm run:*)",
  "Bash(npx vitest:*)",
  "Bash(git status:*)",
  "Bash(git diff:*)",
  "Bash(git log:*)",
];
