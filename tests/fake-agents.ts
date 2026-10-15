import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { QueryFn } from "../src/agents/runner.js";

export type Role = "planner" | "builder";
export interface Call { role: Role; options: Options; prompt: string }
export interface Reply { handoff?: unknown; tokens?: { in: number; out: number }; throws?: Error }
export type Behaviour = (call: Call, n: number) => Reply | Promise<Reply>;

export const handoff = (taskId: number, agent: Role, over: Record<string, unknown> = {}) => ({
  task_id: String(taskId), agent, status: "done", summary: "סיכום", artifacts: [], open_items: ["שלב אחד"], needs_approval: false, confidence: 0.9, ...over,
});

const result = (structured: unknown, t = { in: 100, out: 10 }): SDKMessage =>
  ({ type: "result", subtype: "success", is_error: false, result: "", structured_output: structured,
    modelUsage: { m: { inputTokens: t.in, outputTokens: t.out, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 } } }) as unknown as SDKMessage;

/** Scripted stand-in for the Agent SDK. Default planner returns a plan; default builder writes hello.txt. */
export function fakeAgents(behaviour: Partial<Record<Role, Behaviour>> = {}) {
  const calls: Call[] = [];
  const counts: Record<Role, number> = { planner: 0, builder: 0 };
  const query: QueryFn = async function* ({ prompt, options }) {
    const role: Role = String(options.systemPrompt).includes("planner agent") ? "planner" : "builder";
    const call = { role, options, prompt };
    calls.push(call);
    const taskId = Number(/Task (\d+)/.exec(prompt)?.[1]);
    const n = ++counts[role];
    const custom = behaviour[role];
    if (custom) {
      const r = await custom(call, n);
      if (r.throws) throw r.throws;
      yield result(r.handoff, r.tokens);
    } else if (role === "builder") {
      writeFileSync(join(String(options.cwd), "hello.txt"), "hi\n");
      yield result(handoff(taskId, "builder", { artifacts: ["hello.txt"] }));
    } else {
      yield result(handoff(taskId, "planner"));
    }
  };
  return { query, calls };
}
