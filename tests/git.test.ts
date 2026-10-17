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

  const commit = async (repo: string, msg: string) => {
    await simpleGit(repo).add("-A");
    await simpleGit(repo).raw(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", msg]);
  };

  describe("merge with the owner's unsaved changes set aside", () => {
    it("merges, and puts the unsaved changes back when they do not overlap", async () => {
      const { repo, git } = await makeRepo();
      writeFileSync(join(repo, "other.txt"), "base\n");
      await commit(repo, "other");
      const p = await git.prepare(repo, 3);
      writeFileSync(join(p.worktree, "new.txt"), "from task\n");
      await git.commitAll(p.worktree, "task");
      writeFileSync(join(repo, "other.txt"), "owner edit\n"); // unsaved, tracked

      await expect(git.merge(repo, 3, "main")).rejects.toMatchObject({ reason: "dirty" });
      expect(await git.merge(repo, 3, "main", { stash: true })).toEqual({ stashRestored: true });
      expect(readFileSync(join(repo, "new.txt"), "utf8")).toBe("from task\n");
      expect(readFileSync(join(repo, "other.txt"), "utf8")).toBe("owner edit\n");
      expect(await simpleGit(repo).raw(["stash", "list"])).toBe("");
    });

    it("keeps the owner's changes in git stash when they conflict with the merge", async () => {
      const { repo, git } = await makeRepo();
      const p = await git.prepare(repo, 4);
      writeFileSync(join(p.worktree, "README.md"), "from task\n");
      await git.commitAll(p.worktree, "task");
      writeFileSync(join(repo, "README.md"), "owner edit\n");

      expect(await git.merge(repo, 4, "main", { stash: true })).toEqual({ stashRestored: false });
      expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("from task\n"); // merge done, tree clean
      expect((await simpleGit(repo).status()).isClean()).toBe(true);
      expect(await simpleGit(repo).raw(["stash", "show", "-p"])).toContain("owner edit"); // nothing was lost
    });

    it("gives the changes back when the merge itself fails", async () => {
      const { repo, git } = await makeRepo();
      const p = await git.prepare(repo, 8);
      writeFileSync(join(p.worktree, "README.md"), "from task\n");
      await git.commitAll(p.worktree, "task");
      writeFileSync(join(repo, "README.md"), "from main\n");
      await commit(repo, "main edit"); // makes the merge conflict
      writeFileSync(join(repo, "README.md"), "unsaved on top\n");
      await expect(git.merge(repo, 8, "main", { stash: true })).rejects.toMatchObject({ reason: "conflict" });
      expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("unsaved on top\n");
      expect(await simpleGit(repo).raw(["stash", "list"])).toBe("");
    });
  });

  describe("revert", () => {
    it("undoes a merge with a new commit, and undoing the revert brings the change back", async () => {
      const { repo, git } = await makeRepo();
      const p = await git.prepare(repo, 2);
      writeFileSync(join(p.worktree, "new.txt"), "from task\n");
      await git.commitAll(p.worktree, "task");
      await git.merge(repo, 2, "main");

      const merge = await git.findMerge(repo, 2);
      expect(merge).toMatch(/^[0-9a-f]{40}$/);
      const reverted = await git.revert(repo, merge!, "main");
      expect(existsSync(join(repo, "new.txt"))).toBe(false);
      expect(await simpleGit(repo).raw(["log", "--oneline"])).toContain("Revert");

      await git.revert(repo, reverted, "main"); // undo the revert
      expect(readFileSync(join(repo, "new.txt"), "utf8")).toBe("from task\n");
    });

    it("explains that a later merge must be undone first when it touched the same files", async () => {
      const { repo, git } = await makeRepo();
      const one = await git.prepare(repo, 1);
      writeFileSync(join(one.worktree, "page.txt"), "v1\n");
      await git.commitAll(one.worktree, "task 1");
      await git.merge(repo, 1, "main");
      const two = await git.prepare(repo, 2);
      writeFileSync(join(two.worktree, "page.txt"), "v2\n");
      await git.commitAll(two.worktree, "task 2 fixes task 1");
      await git.merge(repo, 2, "main");

      const first = (await git.findMerge(repo, 1))!;
      await expect(git.revert(repo, first, "main")).rejects.toThrow(/#2/);
      expect((await simpleGit(repo).status()).isClean()).toBe(true); // the failed revert left nothing behind
      // in the right order it works
      await git.revert(repo, (await git.findMerge(repo, 2))!, "main");
      await git.revert(repo, first, "main");
      expect(existsSync(join(repo, "page.txt"))).toBe(false);
    });

    it("does not mistake task 12 for task 1 when looking for a merge", async () => {
      const { repo, git } = await makeRepo();
      const p = await git.prepare(repo, 12);
      writeFileSync(join(p.worktree, "a.txt"), "x\n");
      await git.commitAll(p.worktree, "task 12");
      await git.merge(repo, 12, "main");
      expect(await git.findMerge(repo, 1)).toBeNull();
      expect(await git.findMerge(repo, 12)).toMatch(/^[0-9a-f]{40}$/);
    });

    it("finds no merge for a task that was never merged, and refuses on unsaved changes or the wrong branch", async () => {
      const { repo, git } = await makeRepo();
      expect(await git.findMerge(repo, 99)).toBeNull();
      const p = await git.prepare(repo, 1);
      writeFileSync(join(p.worktree, "a.txt"), "1");
      await git.commitAll(p.worktree, "task");
      await git.merge(repo, 1, "main");
      const merge = (await git.findMerge(repo, 1))!;
      writeFileSync(join(repo, "README.md"), "unsaved\n");
      await expect(git.revert(repo, merge, "main")).rejects.toMatchObject({ reason: "dirty" });
      await expect(git.revert(repo, merge, "develop")).rejects.toMatchObject({ reason: "branch" });
    });
  });

  it("summarises what a task changed per file, without diff content", async () => {
    const { repo, git } = await makeRepo();
    writeFileSync(join(repo, "gone.txt"), "x\n");
    writeFileSync(join(repo, "old-name.txt"), "line1\nline2\nline3\nline4\n");
    await simpleGit(repo).add("-A");
    await simpleGit(repo).raw(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "more"]);
    const p = await git.prepare(repo, 12);
    writeFileSync(join(p.worktree, "README.md"), "hello\nmore\n"); // modified: +1
    writeFileSync(join(p.worktree, "new.txt"), "a\nb\nc\n"); // added: +3
    rmSync(join(p.worktree, "gone.txt")); // deleted
    await simpleGit(p.worktree).raw(["mv", "old-name.txt", "new-name.txt"]);
    await git.commitAll(p.worktree, "task");

    const changes = await git.changeSummary(repo, "main", "task-12");
    const by = Object.fromEntries(changes.map((c) => [c.path, c]));
    expect(by["README.md"]).toEqual({ path: "README.md", status: "modified", added: 1, removed: 0 });
    expect(by["new.txt"]).toEqual({ path: "new.txt", status: "added", added: 3, removed: 0 });
    expect(by["gone.txt"]).toMatchObject({ status: "deleted", removed: 1 });
    expect(by["new-name.txt"]).toMatchObject({ status: "renamed" });
    expect(JSON.stringify(changes)).not.toContain("line1");
  });
});
