import { existsSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { simpleGit } from "simple-git";

export class MergeError extends Error {}
export class SecretFileError extends Error {}

const IDENTITY = ["-c", "user.name=agent-core", "-c", "user.email=agent-core@localhost"];
const SECRET_FILE = /(^|\/)(\.env(\..+)?|id_rsa|id_ed25519|[^/]+\.(pem|key|p12|pfx))$/;
const isSecretFile = (path: string) => SECRET_FILE.test(path) && !/\.env\.(example|sample|template)$/.test(path);

export interface Prepared {
  branch: string;
  base: string;
  worktree: string;
}

/**
 * Branch handling for tasks. Each task gets its own branch `task-<id>` in its own git worktree, so the
 * builder never touches the owner's checkout. Only `merge` ever changes the base branch.
 */
export class GitService {
  constructor(private worktreesDir: string) {}

  worktreePath(repoPath: string, taskId: number): string {
    return join(this.worktreesDir, `${basename(repoPath)}-task-${taskId}`);
  }

  /** Creates (or reuses, after a restart or a rejection) the branch and worktree for a task. */
  async prepare(repoPath: string, taskId: number, knownBase?: string | null): Promise<Prepared> {
    const git = simpleGit(repoPath);
    if (!(await git.checkIsRepo())) throw new Error(`${repoPath} is not a git repository`);
    const branch = `task-${taskId}`;
    if (!(await git.raw(["rev-list", "-n", "1", "--all"]).catch(() => "")).trim()) {
      throw new Error(`${repoPath} has no commits yet: make an initial commit before running tasks on it`);
    }
    const base = knownBase ?? (await git.revparse(["--abbrev-ref", "HEAD"])).trim();
    if (base === "HEAD") throw new Error("repository is in detached HEAD state; check out a branch first");
    const worktree = this.worktreePath(repoPath, taskId);
    if (!existsSync(worktree)) {
      mkdirSync(this.worktreesDir, { recursive: true });
      const branchExists = (await git.branchLocal()).all.includes(branch);
      await git.raw(branchExists ? ["worktree", "add", worktree, branch] : ["worktree", "add", "-b", branch, worktree, base]);
    }
    return { branch, base, worktree };
  }

  /** Commits everything the builder changed. Refuses if a secret-looking file would be included. */
  async commitAll(worktree: string, message: string): Promise<{ committed: boolean; files: string[] }> {
    const git = simpleGit(worktree);
    const status = await git.status();
    const changed = status.files.map((f) => f.path);
    const secrets = changed.filter(isSecretFile);
    if (secrets.length > 0) throw new SecretFileError(`refusing to commit secret-looking files: ${secrets.join(", ")}`);
    if (changed.length === 0) return { committed: false, files: [] };
    await git.add(["-A"]);
    await git.raw([...IDENTITY, "commit", "-m", message]);
    return { committed: true, files: changed };
  }

  /** Files that differ between the base branch and the task branch. */
  async changedFiles(repoPath: string, base: string, branch: string): Promise<string[]> {
    const out = await simpleGit(repoPath).raw(["diff", "--name-only", `${base}...${branch}`]);
    return out.split("\n").filter(Boolean);
  }

  /**
   * Merges the task branch into the base branch in the owner's checkout, then removes the worktree and branch.
   * Needs the owner's checkout to be on the base branch with no uncommitted changes; a conflict is aborted cleanly.
   */
  async merge(repoPath: string, taskId: number, base: string): Promise<void> {
    const git = simpleGit(repoPath);
    const branch = `task-${taskId}`;
    const current = (await git.revparse(["--abbrev-ref", "HEAD"])).trim();
    if (current !== base) throw new MergeError(`the project checkout is on "${current}", expected "${base}"`);
    if (!(await git.status()).isClean()) throw new MergeError("the project checkout has uncommitted changes");
    let failure: string | null = null;
    try {
      await git.raw([...IDENTITY, "merge", "--no-ff", branch, "-m", `Merge ${branch}`]);
    } catch (err) {
      failure = (err as Error).message.split("\n")[0] ?? "unknown error";
    }
    // git reports a conflict on stdout with exit code 1 and an empty stderr, which simple-git does not treat as an error.
    if (failure === null && (await git.status()).conflicted.length > 0) failure = "conflicting changes";
    if (failure !== null) {
      await git.raw(["merge", "--abort"]).catch(() => undefined);
      throw new MergeError(`merge conflict or failure: ${failure}`);
    }
    await this.cleanup(repoPath, taskId);
  }

  async cleanup(repoPath: string, taskId: number): Promise<void> {
    const git = simpleGit(repoPath);
    const worktree = this.worktreePath(repoPath, taskId);
    if (existsSync(worktree)) await git.raw(["worktree", "remove", "--force", worktree]);
    await git.raw(["branch", "-D", `task-${taskId}`]).catch(() => undefined);
  }
}
