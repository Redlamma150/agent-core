import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { simpleGit } from "simple-git";
import type { Db } from "../db/index.js";

export interface ProjectInput {
  name: string;
  repoPath: string;
  /** Path of the context file, relative to the repository. */
  contextFile?: string;
  /** Command run in the task's worktree before approval, e.g. "npm test". Split on spaces, no shell. */
  testCommand?: string;
}

/** Registers (or updates) a project after checking that the repo and context file are usable. */
export async function registerProject(db: Db, input: ProjectInput): Promise<{ id: number; warnings: string[] }> {
  const name = input.name.trim();
  if (!name) throw new Error("project name must not be empty");
  if (!isAbsolute(input.repoPath)) throw new Error("repo path must be absolute");
  const repo = resolve(input.repoPath);
  if (!existsSync(repo) || !statSync(repo).isDirectory()) throw new Error(`${repo} does not exist`);
  const git = simpleGit(repo);
  if (!(await git.checkIsRepo())) throw new Error(`${repo} is not a git repository`);

  const warnings: string[] = [];
  if (input.contextFile) {
    const file = resolve(repo, input.contextFile);
    if (!file.startsWith(repo + sep)) throw new Error("context file must be inside the repository");
    if (!existsSync(file)) throw new Error(`context file ${input.contextFile} not found in the repository`);
  }
  if (!(await git.raw(["rev-list", "-n", "1", "--all"]).catch(() => "")).trim()) {
    warnings.push("the repository has no commits yet; make an initial commit before running tasks on it");
  }

  db.prepare(
    "INSERT INTO projects (name, repo_path, context_file, test_command) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET repo_path = excluded.repo_path, context_file = excluded.context_file, test_command = excluded.test_command",
  ).run(name, repo, input.contextFile ?? null, input.testCommand?.trim() || null);
  const row = db.prepare("SELECT id FROM projects WHERE name = ?").get(name) as { id: number };
  return { id: row.id, warnings };
}
