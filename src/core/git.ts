import { existsSync, mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { simpleGit } from "simple-git";

/** Why a merge or revert could not run. "dirty" means unsaved changes in the project: the owner can have them set aside. */
export type MergeReason = "dirty" | "branch" | "conflict" | "missing";
export class MergeError extends Error {
  constructor(message: string, readonly reason: MergeReason = "conflict") {
    super(message);
  }
}
export class SecretFileError extends Error {}

const IDENTITY = ["-c", "user.name=agent-core", "-c", "user.email=agent-core@localhost"];
const SECRET_FILE = /(^|\/)(\.env(\..+)?|id_rsa|id_ed25519|[^/]+\.(pem|key|p12|pfx))$/;
const isSecretFile = (path: string) => SECRET_FILE.test(path) && !/\.env\.(example|sample|template)$/.test(path);

export interface FileChange {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  added: number;
  removed: number;
}

export interface MergeOutcome {
  /** null: nothing was set aside. false: the owner's changes could not be put back on top of the merge and stay in `git stash`. */
  stashRestored: boolean | null;
}

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
  private worktreesDir: string;

  constructor(worktreesDir: string) {
    // Always absolute: git runs inside the project's repo, so a relative path would land worktrees inside the owner's repo.
    this.worktreesDir = resolve(worktreesDir);
  }

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

  /** What changed on the task branch, per file: how (added, changed, deleted, renamed) and how many lines. No diff content. */
  async changeSummary(repoPath: string, base: string, branch: string): Promise<FileChange[]> {
    const git = simpleGit(repoPath);
    const range = `${base}...${branch}`;
    const [names, nums] = await Promise.all([git.raw(["diff", "--name-status", "-M", range]), git.raw(["diff", "--numstat", "-M", range])]);
    const lines = new Map<string, { added: number; removed: number }>();
    for (const row of nums.split("\n").filter(Boolean)) {
      const [a, r, ...rest] = row.split("\t");
      const path = rest.join("\t").replace(/^.*\{.* => (.*)\}(.*)$/, "$1$2").replace(/^.* => /, "");
      lines.set(path, { added: a === "-" ? 0 : Number(a), removed: r === "-" ? 0 : Number(r) });
    }
    return names.split("\n").filter(Boolean).map((row) => {
      const [code = "M", ...paths] = row.split("\t");
      const path = paths[paths.length - 1] ?? "";
      const status: FileChange["status"] = code.startsWith("A") ? "added" : code.startsWith("D") ? "deleted" : code.startsWith("R") ? "renamed" : "modified";
      return { path, status, ...(lines.get(path) ?? { added: 0, removed: 0 }) };
    });
  }

  /**
   * Merges the task branch into the base branch in the owner's checkout, then removes the worktree and branch.
   * Needs the owner's checkout to be on the base branch with no uncommitted changes; a conflict is aborted cleanly.
   */
  async merge(repoPath: string, taskId: number, base: string, opts: { stash?: boolean } = {}): Promise<MergeOutcome> {
    const git = simpleGit(repoPath);
    const branch = `task-${taskId}`;
    const current = (await git.revparse(["--abbrev-ref", "HEAD"])).trim();
    // These messages go straight to the owner in the app, so they are in Hebrew and say what to do.
    if (current !== base) throw new MergeError(`תיקיית הפרויקט פתוחה כרגע על הענף "${current}" ולא על "${base}". עבור ל-${base} ונסה לאשר שוב.`, "branch");
    // Only changes to tracked files block a merge. Untracked files (.DS_Store, notes) are harmless: if one of them
    // would be overwritten by the task, git itself refuses the merge below and it is aborted cleanly.
    const dirty = (await git.raw(["status", "--porcelain", "--untracked-files=no"])).trim() !== "";
    if (dirty && !opts.stash) {
      throw new MergeError("יש בתיקיית הפרויקט שינויים בקבצים שלא נשמרו (commit). שמור אותם או בטל אותם ונסה לאשר שוב.", "dirty");
    }
    // Set the owner's unsaved changes aside (tracked files only) and bring them back after the merge.
    const stashTag = `agent-core task-${taskId}`;
    if (dirty) await git.raw([...IDENTITY, "stash", "push", "-m", stashTag]);
    const restore = async (): Promise<MergeOutcome> => {
      if (!dirty) return { stashRestored: null };
      try {
        await git.raw(["stash", "pop"]);
        if ((await git.status()).conflicted.length === 0) return { stashRestored: true };
      } catch {
        // fall through: the pop hit a conflict
      }
      // The changes would conflict with the merged ones. Remove the half applied state; git keeps the stash entry.
      await git.raw(["reset", "--hard", "HEAD"]).catch(() => undefined);
      return { stashRestored: false };
    };
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
      if (dirty) await git.raw(["stash", "pop"]).catch(() => undefined); // nothing was merged: give the owner their changes back
      throw new MergeError(`המיזוג נכשל (${failure}). ייתכן שהשינויים מתנגשים עם שינויים שעשית בפרויקט.`, "conflict");
    }
    await this.cleanup(repoPath, taskId);
    return restore();
  }

  /** The commit that merged a task into the base branch (merges are always `Merge task-<id>`), or null if it cannot be found. */
  async findMerge(repoPath: string, taskId: number): Promise<string | null> {
    // Anchored: "Merge task-1" must not match "Merge task-12".
    const out = await simpleGit(repoPath).raw(["log", "--merges", "-1", "--format=%H", `--grep=^Merge task-${taskId}$`]).catch(() => "");
    return out.trim() || null;
  }

  /** Task numbers merged after the given commit, newest first, for explaining why an older merge cannot be undone alone. */
  private async mergedAfter(repoPath: string, commit: string): Promise<number[]> {
    const out = await simpleGit(repoPath).raw(["log", "--merges", "--format=%s", `${commit}..HEAD`]).catch(() => "");
    return out.split("\n").map((s) => /^Merge task-(\d+)$/.exec(s)?.[1]).filter((n): n is string => n !== undefined).map(Number);
  }

  /**
   * Undoes a merge with a new commit on the base branch (nothing is rewritten or deleted), so it can itself be undone.
   * Returns the new commit. Needs the owner's checkout on the base branch without unsaved changes, like a merge does.
   */
  async revert(repoPath: string, commit: string, base: string): Promise<string> {
    const git = simpleGit(repoPath);
    const current = (await git.revparse(["--abbrev-ref", "HEAD"])).trim();
    if (current !== base) throw new MergeError(`תיקיית הפרויקט פתוחה כרגע על הענף "${current}" ולא על "${base}". עבור ל-${base} ונסה שוב.`, "branch");
    if ((await git.raw(["status", "--porcelain", "--untracked-files=no"])).trim() !== "") {
      throw new MergeError("יש בתיקיית הפרויקט שינויים בקבצים שלא נשמרו (commit). שמור אותם או בטל אותם ונסה שוב.", "dirty");
    }
    const parents = (await git.raw(["rev-list", "--parents", "-n", "1", commit])).trim().split(" ").length - 1;
    let failure: string | null = null;
    try {
      await git.raw([...IDENTITY, "revert", ...(parents > 1 ? ["-m", "1"] : []), "--no-edit", commit]);
    } catch (err) {
      failure = (err as Error).message.split("\n")[0] ?? "unknown error";
    }
    if (failure === null && (await git.status()).conflicted.length > 0) failure = "conflicting changes";
    if (failure !== null) {
      await git.raw(["revert", "--abort"]).catch(() => undefined);
      const later = await this.mergedAfter(repoPath, commit);
      throw new MergeError(
        later.length > 0
          ? `אי אפשר להחזיר את המיזוג הזה, כי משימות שמוזגו אחריו (${later.map((n) => `#${n}`).join(", ")}) שינו את אותם קבצים. החזר קודם את ${later.length === 1 ? "משימה" : "המשימות"} ${later.map((n) => `#${n}`).join(", ")}, ואז את הזאת.`
          : `ההחזרה נכשלה (${failure}). ייתכן שקבצים אלה השתנו מאז המיזוג.`,
        "conflict",
      );
    }
    return (await git.revparse(["HEAD"])).trim();
  }

  async cleanup(repoPath: string, taskId: number): Promise<void> {
    const git = simpleGit(repoPath);
    const worktree = this.worktreePath(repoPath, taskId);
    if (existsSync(worktree)) await git.raw(["worktree", "remove", "--force", worktree]);
    await git.raw(["branch", "-D", `task-${taskId}`]).catch(() => undefined);
  }
}
