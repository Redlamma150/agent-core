import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { afterEach } from "vitest";
import { GitService } from "../src/core/git.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

export async function makeRepo(): Promise<{ repo: string; work: string; git: GitService }> {
  const root = mkdtempSync(join(tmpdir(), "git-"));
  dirs.push(root);
  const repo = join(root, "proj");
  const g = simpleGit();
  await g.raw(["init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, "README.md"), "hello\n");
  const rg = simpleGit(repo);
  await rg.add("-A");
  await rg.raw(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"]);
  return { repo, work: join(root, "worktrees"), git: new GitService(join(root, "worktrees")) };
}

