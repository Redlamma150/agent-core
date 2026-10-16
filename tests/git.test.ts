import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { simpleGit } from "simple-git";
import { describe, expect, it } from "vitest";
import { GitService, MergeError, SecretFileError } from "../src/core/git.js";
import { makeRepo } from "./repo-helper.js";

describe("GitService", () => {
  it("keeps worktrees out of the project repo even when given a relative directory", async () => {
    const { repo } = await makeRepo();
    const relative = new GitService("rel-worktrees"); // relative to the test process, not to the repo
    const p = await relative.prepare(repo, 9);
    try {
      expect(isAbsolute(p.worktree)).toBe(true);
      expect(p.worktree.startsWith(repo)).toBe(false);
      expect(existsSync(p.worktree)).toBe(true);
    } finally {
      await relative.cleanup(repo, 9);
      rmSync("rel-worktrees", { recursive: true, force: true });
    }
  });

  it("builds on a task branch in its own worktree and leaves the owner's checkout alone", async () => {
    const { repo, git } = await makeRepo();
    const p = await git.prepare(repo, 7);
    expect(p).toMatchObject({ branch: "task-7", base: "main" });
    writeFileSync(join(p.worktree, "new.txt"), "x");
    expect(await git.commitAll(p.worktree, "task-7: add")).toEqual({ committed: true, files: ["new.txt"] });
    expect(existsSync(join(repo, "new.txt"))).toBe(false);
    expect((await simpleGit(repo).revparse(["--abbrev-ref", "HEAD"])).trim()).toBe("main");
    expect(await git.changedFiles(repo, "main", "task-7")).toEqual(["new.txt"]);
  });

  it("reuses the worktree on a second prepare (after a restart or a rejection)", async () => {
    const { repo, git } = await makeRepo();
    const a = await git.prepare(repo, 1);
    writeFileSync(join(a.worktree, "a.txt"), "1");
    await git.commitAll(a.worktree, "one");
    const b = await git.prepare(repo, 1, "main");
    expect(b.worktree).toBe(a.worktree);
    expect(existsSync(join(b.worktree, "a.txt"))).toBe(true);
  });

  it("merges with a merge commit, then removes the worktree and the branch", async () => {
    const { repo, git } = await makeRepo();
    const p = await git.prepare(repo, 2);
    writeFileSync(join(p.worktree, "feature.txt"), "f");
    await git.commitAll(p.worktree, "feat");
    await git.merge(repo, 2, "main");
    expect(readFileSync(join(repo, "feature.txt"), "utf8")).toBe("f");
    expect(existsSync(p.worktree)).toBe(false);
    expect((await simpleGit(repo).branchLocal()).all).toEqual(["main"]);
    expect(await simpleGit(repo).raw(["log", "-1", "--pretty=%s"])).toContain("Merge task-2");
  });

  it("reports nothing to commit when the builder changed nothing", async () => {
    const { repo, git } = await makeRepo();
    const p = await git.prepare(repo, 3);
    expect(await git.commitAll(p.worktree, "none")).toEqual({ committed: false, files: [] });
  });

  it("refuses to commit secret-looking files but allows .env.example", async () => {
    const { repo, git } = await makeRepo();
    const p = await git.prepare(repo, 4);
    writeFileSync(join(p.worktree, ".env.example"), "A=");
    writeFileSync(join(p.worktree, "ok.txt"), "ok");
    expect((await git.commitAll(p.worktree, "fine")).committed).toBe(true);
    for (const name of [".env", ".env.local", "server.pem", "id_rsa"]) {
      writeFileSync(join(p.worktree, name), "SECRET=1");
      await expect(git.commitAll(p.worktree, "bad")).rejects.toThrow(SecretFileError);
      rmSync(join(p.worktree, name));
    }
  });

  it("ignores untracked files such as .DS_Store, and still refuses when one would be overwritten", async () => {
    const { repo, git } = await makeRepo();
    const p = await git.prepare(repo, 6);
    writeFileSync(join(p.worktree, "new.txt"), "from task\n");
    await git.commitAll(p.worktree, "add new");
    writeFileSync(join(repo, ".DS_Store"), "junk");
    writeFileSync(join(repo, "new.txt"), "owner's own untracked file\n"); // same name as the task's new file
    await expect(git.merge(repo, 6, "main")).rejects.toThrow(MergeError);
    expect(readFileSync(join(repo, "new.txt"), "utf8")).toBe("owner's own untracked file\n");
    rmSync(join(repo, "new.txt"));
    await git.merge(repo, 6, "main"); // only .DS_Store is untracked now: merge goes through
    expect(readFileSync(join(repo, "new.txt"), "utf8")).toBe("from task\n");
  });

  it("refuses to merge into a dirty or wrong checkout, and aborts conflicts cleanly", async () => {
    const { repo, git } = await makeRepo();
    const p = await git.prepare(repo, 5);
    writeFileSync(join(p.worktree, "README.md"), "from task\n");
    await git.commitAll(p.worktree, "edit readme");

    writeFileSync(join(repo, "scratch.txt"), "x");
    await simpleGit(repo).add("scratch.txt");
    await expect(git.merge(repo, 5, "main")).rejects.toThrow(/שינויים בקבצים שלא נשמרו/);
    await simpleGit(repo).raw(["reset", "-q"]);
    rmSync(join(repo, "scratch.txt"));

    await expect(git.merge(repo, 5, "develop")).rejects.toThrow(/ולא על "develop"/);

    // conflicting change on main
    writeFileSync(join(repo, "README.md"), "from main\n");
    await simpleGit(repo).add("-A");
    await simpleGit(repo).raw(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "main edit"]);
    await expect(git.merge(repo, 5, "main")).rejects.toThrow(MergeError);
    expect((await simpleGit(repo).status()).isClean()).toBe(true); // merge was aborted
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("from main\n");
    expect(existsSync(p.worktree)).toBe(true); // task work is kept for the owner to decide
  });
});
