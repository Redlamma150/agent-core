import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { simpleGit } from "simple-git";
import { describe, expect, it } from "vitest";
import { AgentRunner, type QueryFn } from "../src/agents/runner.js";
import { ApprovalService } from "../src/core/approvals.js";
import { BudgetService } from "../src/core/budget.js";
import { MergeError } from "../src/core/git.js";
import { MediaService } from "../src/core/media.js";
import { ScreenshotService } from "../src/core/screenshots.js";
import { Pipeline } from "../src/core/pipeline.js";
import { TaskService } from "../src/core/tasks.js";
import { openDb } from "../src/db/index.js";
import { makeRepo } from "./repo-helper.js";

type Role = "planner" | "builder";
interface Call { role: Role; options: Options; prompt: string }
type Behaviour = (call: Call) => unknown | Promise<unknown>;

const handoff = (taskId: number, agent: Role, over: Record<string, unknown> = {}) => ({
  task_id: String(taskId), agent, status: "done", summary: "סיכום", artifacts: [], open_items: [], needs_approval: false, confidence: 0.9, ...over,
});

const done = (structured: unknown): SDKMessage =>
  ({ type: "result", subtype: "success", is_error: false, result: "", structured_output: structured, modelUsage: { m: { inputTokens: 10, outputTokens: 5, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 } } }) as unknown as SDKMessage;

async function setup(behaviour: Partial<Record<Role, Behaviour>> = {}, timeoutMs?: number, screenshots?: (media: MediaService) => ScreenshotService) {
  const { repo, git } = await makeRepo();
  const db = openDb(":memory:");
  db.prepare("INSERT INTO projects (name, repo_path) VALUES ('proj', ?)").run(repo);
  const tasks = new TaskService(db);
  const approvals = new ApprovalService(db, tasks, { reminderMinutes: 10, reminderCount: 2 });
  const calls: Call[] = [];
  const query: QueryFn = async function* ({ prompt, options }) {
    const role: Role = String(options.systemPrompt).includes("planner agent") ? "planner" : "builder";
    const call = { role, options, prompt };
    calls.push(call);
    const custom = behaviour[role];
    const taskId = Number(/Task (\d+)/.exec(prompt)?.[1]);
    if (custom) yield done(await custom(call));
    else if (role === "builder") {
      writeFileSync(join(String(options.cwd), "hello.txt"), "hi\n");
      yield done(handoff(taskId, "builder", { artifacts: ["hello.txt"] }));
    } else yield done(handoff(taskId, "planner", { open_items: ["צור את hello.txt"] }));
  };
  const runner = new AgentRunner(db, tasks, query);
  const media = new MediaService(db, join(repo, "..", "uploads"));
  const pipeline = new Pipeline({ db, tasks, approvals, runner, budget: new BudgetService(tasks, 1_000_000), git, media, screenshots: screenshots?.(media), timeoutMs }, () => {});
  const task = tasks.create(1, "add hello.txt");
  return { repo, db, tasks, approvals, pipeline, calls, task, git, runner, media, budgetCap: 1_000_000 };
}

describe("pipeline", () => {
  it("runs planner then builder on a task branch and asks for approval; approve merges", async () => {
    const t = await setup();
    t.pipeline.start(t.task.id);
    await t.pipeline.idle();

    expect(t.calls.map((c) => c.role)).toEqual(["planner", "builder"]);
    const task = t.tasks.get(t.task.id);
    expect(task).toMatchObject({ status: "awaiting_approval", branch: "task-1", base_branch: "main" });
    const [approval] = t.approvals.pending();
    expect(approval?.request_text).toContain("hello.txt");
    expect(existsSync(join(t.repo, "hello.txt"))).toBe(false); // main checkout untouched until approval

    await t.pipeline.resolveApproval(approval!.id, true);
    expect(t.tasks.get(t.task.id).status).toBe("merged");
    expect(readFileSync(join(t.repo, "hello.txt"), "utf8")).toBe("hi\n");
    expect((await simpleGit(t.repo).branchLocal()).all).toEqual(["main"]);
  });

  it("gives the planner read-only tools and the builder its worktree and a whitelist, not bare Bash", async () => {
    const t = await setup();
    t.pipeline.start(t.task.id);
    await t.pipeline.idle();
    const [planner, builder] = t.calls;
    expect(planner?.options).toMatchObject({ tools: ["Read", "Grep", "Glob"], permissionMode: "dontAsk", cwd: t.repo });
    expect(builder?.options.cwd).toContain("task-1");
    expect(builder?.options.cwd).not.toBe(t.repo);
    expect(builder?.options.allowedTools).not.toContain("Bash");
    expect(builder?.options.allowedTools?.some((x) => x.startsWith("Bash("))).toBe(true);
    expect(builder?.options.allowedTools?.join(" ")).not.toMatch(/git (commit|push|merge|checkout)/);
    expect(builder?.prompt).toContain("צור את hello.txt"); // plan reaches the builder
  });

  it("reject sends the owner's notes back to the builder, then approve merges both rounds", async () => {
    const t = await setup({
      builder: ({ prompt, options }) => {
        const second = prompt.includes("rejected");
        writeFileSync(join(String(options.cwd), second ? "second.txt" : "first.txt"), "x");
        return handoff(1, "builder");
      },
    });
    t.pipeline.start(t.task.id);
    await t.pipeline.idle();
    const first = t.approvals.pending()[0]!;
    await t.pipeline.resolveApproval(first.id, false, "תוסיף גם קובץ שני");
    await t.pipeline.idle();

    expect(t.calls.filter((c) => c.role === "planner")).toHaveLength(1); // no re-planning
    expect(t.calls[2]?.prompt).toContain("תוסיף גם קובץ שני");
    expect(t.tasks.get(t.task.id).status).toBe("awaiting_approval");
    await t.pipeline.resolveApproval(t.approvals.pending()[0]!.id, true);
    expect(existsSync(join(t.repo, "first.txt")) && existsSync(join(t.repo, "second.txt"))).toBe(true);
  });

  it("hands the project's context file to both agents", async () => {
    const t = await setup();
    writeFileSync(join(t.repo, "CONTEXT.md"), "RULE: never name employers");
    t.db.prepare("UPDATE projects SET context_file = 'CONTEXT.md'").run();
    t.pipeline.start(t.task.id);
    await t.pipeline.idle();
    for (const call of t.calls) expect(call.prompt).toContain("RULE: never name employers");
  });

  it("blocks when the planner cannot plan, without running the builder", async () => {
    const t = await setup({ planner: () => handoff(1, "planner", { status: "blocked", summary: "חסר מידע" }) });
    t.pipeline.start(t.task.id);
    await t.pipeline.idle();
    expect(t.tasks.get(t.task.id).status).toBe("blocked");
    expect(t.calls.map((c) => c.role)).toEqual(["planner"]);
  });

  it("blocks when the builder changed no files", async () => {
    const t = await setup({ builder: () => handoff(1, "builder") });
    t.pipeline.start(t.task.id);
    await t.pipeline.idle();
    expect(t.tasks.get(t.task.id).status).toBe("blocked");
    expect(t.approvals.pending()).toHaveLength(0);
  });

  it("blocks and commits nothing when the builder writes a secret file", async () => {
    const t = await setup({
      builder: ({ options }) => {
        writeFileSync(join(String(options.cwd), ".env"), "TOKEN=abc");
        return handoff(1, "builder");
      },
    });
    t.pipeline.start(t.task.id);
    await t.pipeline.idle();
    expect(t.tasks.get(t.task.id).status).toBe("blocked");
    expect(await simpleGit(t.repo).raw(["log", "task-1", "--oneline"])).not.toContain("task-1:");
    expect(t.db.prepare("SELECT summary FROM steps WHERE to_status = 'blocked'").get()).toMatchObject({ summary: expect.stringContaining("secret") });
  });

  it("keeps the approval pending when the merge fails, and says why", async () => {
    const t = await setup();
    t.pipeline.start(t.task.id);
    await t.pipeline.idle();
    writeFileSync(join(t.repo, "README.md"), "owner is editing\n"); // uncommitted change in the owner's checkout
    const approval = t.approvals.pending()[0]!;
    await expect(t.pipeline.resolveApproval(approval.id, true)).rejects.toThrow(MergeError);
    expect(t.approvals.get(approval.id).status).toBe("pending");
    expect(t.tasks.get(t.task.id).status).toBe("awaiting_approval");
  });

  it("stop aborts the running agent and leaves no approval", async () => {
    let release!: () => void;
    let signal: AbortSignal | undefined;
    const t = await setup({
      builder: async ({ options }) => {
        signal = options.abortController?.signal;
        await new Promise<void>((r) => (release = r));
        return handoff(1, "builder");
      },
    });
    t.pipeline.start(t.task.id);
    await new Promise((r) => setTimeout(r, 100));
    t.pipeline.stop(t.task.id);
    expect(signal?.aborted).toBe(true);
    release();
    await t.pipeline.idle();
    expect(t.tasks.get(t.task.id).status).toBe("stopped");
    expect(t.approvals.pending()).toHaveLength(0);
  });

  it("blocks a task that runs past the time limit, aborts its agent and keeps the queue moving", async () => {
    let signal: AbortSignal | undefined;
    // The builder hangs and ignores the abort completely (the worst case): it never returns.
    const t = await setup({ builder: async ({ options }) => { signal = options.abortController?.signal; return new Promise(() => {}); } }, 150);
    t.pipeline.start(t.task.id);
    await t.pipeline.idle();
    expect(signal?.aborted).toBe(true);
    expect(t.tasks.get(t.task.id).status).toBe("blocked");
    const why = t.db.prepare("SELECT summary FROM steps WHERE to_status = 'blocked'").get() as { summary: string };
    expect(why.summary).toContain("נעצרה");
    expect(t.approvals.pending()).toHaveLength(0);

    // the next task is not held up by the hung one
    const other = t.tasks.create(1, "second");
    t.calls.length = 0;
    t.pipeline.start(other.id);
    await t.pipeline.idle();
    expect(t.calls.length).toBeGreaterThan(0);
    expect(t.tasks.get(other.id).status).toBe("blocked"); // same hung builder, same limit: the point is that it got to run
  });

  it("a task that finishes in time is untouched by the limit, and continuing starts a fresh clock", async () => {
    const t = await setup({}, 5_000);
    t.pipeline.start(t.task.id);
    await t.pipeline.idle();
    expect(t.tasks.get(t.task.id).status).toBe("awaiting_approval");
  });

  it("after a restart in the middle of building, resumes at the builder with the saved plan", async () => {
    const t = await setup();
    t.pipeline.start(t.task.id);
    await t.pipeline.idle();
    // simulate: task was mid-build when the core died (approval never created)
    const t2 = await setup();
    t2.tasks.transition(t2.task.id, "planning");
    t2.db.prepare("INSERT INTO steps (task_id, agent, status, summary, handoff) VALUES (1, 'planner', 'done', 'x', ?)").run(JSON.stringify(handoff(1, "planner", { open_items: ["שלב שמור"] })));
    t2.tasks.transition(t2.task.id, "in_progress");
    expect(t2.pipeline.resume()).toBe(1);
    await t2.pipeline.idle();
    expect(t2.calls.map((c) => c.role)).toEqual(["builder"]);
    expect(t2.calls[0]?.prompt).toContain("שלב שמור");
    expect(t2.tasks.get(t2.task.id).status).toBe("awaiting_approval");
  });

  it("an unexpected error parks the task as blocked with the reason", async () => {
    const t = await setup();
    t.db.prepare("UPDATE projects SET repo_path = '/does/not/exist'").run();
    t.pipeline.start(t.task.id);
    await t.pipeline.idle();
    expect(t.tasks.get(t.task.id).status).toBe("blocked");
  });

  describe("screenshots", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]);
    const fake = (fail = false) => (media: MediaService) => new ScreenshotService(media, async () => {
      if (fail) throw new Error("no browser");
      return { shoot: async () => png, close: async () => undefined };
    });
    const buildsPage: Behaviour = (call) => {
      writeFileSync(join(String(call.options.cwd), "index.html"), "<h1>hi</h1>");
      return handoff(Number(/Task (\d+)/.exec(call.prompt)?.[1]), "builder", { artifacts: ["index.html"] });
    };

    it("takes screenshots after the build and mentions them in the approval request", async () => {
      const t = await setup({ builder: buildsPage }, undefined, fake());
      t.pipeline.start(t.task.id);
      await t.pipeline.idle();
      expect(t.tasks.get(t.task.id).status).toBe("awaiting_approval");
      expect(t.media.list(t.task.id).map((a) => a.name).sort()).toEqual(["after-desktop.png", "after-phone.png"]);
      expect(t.approvals.pending()[0]!.request_text).toContain("צילומי");
    });

    it("still asks for approval when the browser cannot start, and records why", async () => {
      const t = await setup({ builder: buildsPage }, undefined, fake(true));
      t.pipeline.start(t.task.id);
      await t.pipeline.idle();
      expect(t.tasks.get(t.task.id).status).toBe("awaiting_approval");
      expect(t.media.list(t.task.id)).toEqual([]);
      const statuses = (t.db.prepare("SELECT status FROM steps WHERE task_id = ?").all(t.task.id) as { status: string }[]).map((r) => r.status);
      expect(statuses).toContain("screenshots_failed");
    });
  });
});
