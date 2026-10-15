import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { describe, expect, it } from "vitest";
import { projectContext } from "../src/core/pipeline.js";
import { registerProject } from "../src/core/projects.js";
import { openDb } from "../src/db/index.js";
import { makeRepo } from "./repo-helper.js";

describe("registerProject", () => {
  it("registers a project with its context file and updates it on a second call", async () => {
    const { repo } = await makeRepo();
    writeFileSync(join(repo, "CONTEXT.md"), "# rules");
    const db = openDb(":memory:");
    const first = await registerProject(db, { name: "gigs", repoPath: repo, contextFile: "CONTEXT.md" });
    expect(first.warnings).toEqual([]);
    expect(db.prepare("SELECT name, repo_path, context_file FROM projects").all()).toEqual([{ name: "gigs", repo_path: repo, context_file: "CONTEXT.md" }]);
    const again = await registerProject(db, { name: "gigs", repoPath: repo });
    expect(again.id).toBe(first.id);
    expect(db.prepare("SELECT context_file FROM projects").get()).toEqual({ context_file: null });
  });

  it("rejects bad input", async () => {
    const { repo } = await makeRepo();
    const db = openDb(":memory:");
    await expect(registerProject(db, { name: " ", repoPath: repo })).rejects.toThrow(/name/);
    await expect(registerProject(db, { name: "x", repoPath: "relative/path" })).rejects.toThrow(/absolute/);
    await expect(registerProject(db, { name: "x", repoPath: "/does/not/exist" })).rejects.toThrow(/does not exist/);
    await expect(registerProject(db, { name: "x", repoPath: repo, contextFile: "MISSING.md" })).rejects.toThrow(/not found/);
    await expect(registerProject(db, { name: "x", repoPath: repo, contextFile: "../outside.md" })).rejects.toThrow(/inside the repository/);
    const notRepo = mkdtempSync(join(tmpdir(), "plain-"));
    try {
      await expect(registerProject(db, { name: "x", repoPath: notRepo })).rejects.toThrow(/not a git repository/);
    } finally {
      rmSync(notRepo, { recursive: true, force: true });
    }
  });

  it("warns when the repository has no commits yet", async () => {
    const dir = mkdtempSync(join(tmpdir(), "empty-"));
    try {
      await simpleGit().raw(["init", "-q", "-b", "main", dir]);
      const { warnings } = await registerProject(openDb(":memory:"), { name: "e", repoPath: dir });
      expect(warnings[0]).toMatch(/no commits/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("projectContext", () => {
  it("reads the context file, even when it is not committed", async () => {
    const { repo } = await makeRepo();
    writeFileSync(join(repo, "CONTEXT.md"), "Never mention employers.");
    expect(projectContext({ repo_path: repo, context_file: "CONTEXT.md" })).toContain("Never mention employers.");
  });

  it("returns nothing for no file, a missing file, a directory or a path outside the repo", async () => {
    const { repo } = await makeRepo();
    mkdirSync(join(repo, "docs"));
    writeFileSync(join(repo, "..", "outside.md"), "secret outside");
    for (const context_file of [null, "NOPE.md", "docs", "../outside.md"]) {
      expect(projectContext({ repo_path: repo, context_file })).toBe("");
    }
  });

  it("caps very large context files", async () => {
    const { repo } = await makeRepo();
    writeFileSync(join(repo, "CONTEXT.md"), "x".repeat(100_000));
    expect(projectContext({ repo_path: repo, context_file: "CONTEXT.md" }).length).toBeLessThan(21_000);
  });
});
