import type { Options, PermissionMode, SDKMessage, SDKResultMessage, SettingSource } from "@anthropic-ai/claude-agent-sdk";
import type { Db } from "../db/index.js";
import type { TaskService } from "../core/tasks.js";
import { handoffJsonSchema, parseHandoff, type AgentRole, type Handoff } from "./contract.js";

export type QueryFn = (params: { prompt: string; options: Options }) => AsyncIterable<SDKMessage>;

export interface RunRequest {
  taskId: number;
  role: AgentRole;
  model: string;
  prompt: string;
  systemPrompt: string;
  cwd: string;
  /**
   * The built-in tools the agent gets (e.g. ["Read", "Grep", "Glob"]). Every tool adds to the prompt the model
   * reads on each call, so give each role only what it needs. Omit for the full default set; [] for no tools.
   */
  tools?: string[];
  allowedTools?: string[];
  /** Settings files to load. Default none: cheaper, and the agent does not pick up personal settings. */
  settingSources?: SettingSource[];
  permissionMode?: PermissionMode;
  maxTurns?: number;
  /** True when this call is the first one after an escalation; recorded in llm_calls. */
  escalated?: boolean;
  signal?: AbortSignal;
}

export type RunResult = { ok: true; handoff: Handoff; tokens: number } | { ok: false; reason: string; tokens: number };

const defaultQuery: QueryFn = async function* (params) {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  yield* query(params);
};

/** Tokens that count against the task cap: fresh input, cache writes and output. Cache reads are excluded. */
export function countTokens(result: SDKResultMessage): number {
  return Object.values(result.modelUsage ?? {}).reduce((sum, m) => sum + m.inputTokens + m.outputTokens + m.cacheCreationInputTokens, 0);
}

export class AgentRunner {
  constructor(private db: Db, private tasks: TaskService, private queryFn: QueryFn = defaultQuery) {}

  /** Runs one agent call, validates its output against the handoff contract and logs it to llm_calls. */
  async run(req: RunRequest): Promise<RunResult> {
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    req.signal?.addEventListener("abort", onAbort);

    let result: SDKResultMessage | undefined;
    let outcome: { ok: true; handoff: Handoff } | { ok: false; reason: string };
    try {
      const options: Options = {
        model: req.model,
        systemPrompt: req.systemPrompt,
        cwd: req.cwd,
        tools: req.tools,
        allowedTools: req.allowedTools,
        permissionMode: req.permissionMode,
        maxTurns: req.maxTurns ?? 30,
        outputFormat: { type: "json_schema", schema: handoffJsonSchema },
        settingSources: req.settingSources ?? [],
        abortController: abort,
        // Agents must run on the Claude subscription: never hand the SDK an API key, even if one leaks into the environment.
        env: { ...process.env, ANTHROPIC_API_KEY: undefined },
      };
      for await (const message of this.queryFn({ prompt: req.prompt, options })) {
        if (message.type === "result") result = message;
      }
      outcome = result ? this.validate(result, req) : { ok: false, reason: "agent produced no result" };
    } catch (err) {
      outcome = { ok: false, reason: `agent call failed: ${(err as Error).message}` };
    } finally {
      req.signal?.removeEventListener("abort", onAbort);
    }

    const tokens = result ? countTokens(result) : 0;
    this.db
      .prepare("INSERT INTO llm_calls (task_id, agent, model, input_tokens, output_tokens, valid_output, escalated) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(
        req.taskId,
        req.role,
        req.model,
        Object.values(result?.modelUsage ?? {}).reduce((s, m) => s + m.inputTokens + m.cacheCreationInputTokens, 0),
        Object.values(result?.modelUsage ?? {}).reduce((s, m) => s + m.outputTokens, 0),
        outcome.ok ? 1 : 0,
        req.escalated ? 1 : 0,
      );
    this.tasks.addTokens(req.taskId, tokens);
    return outcome.ok ? { ok: true, handoff: outcome.handoff, tokens } : { ok: false, reason: outcome.reason, tokens };
  }

  private validate(result: SDKResultMessage, req: RunRequest) {
    if (result.subtype !== "success" || result.is_error) {
      return { ok: false as const, reason: `agent error: ${result.subtype === "success" ? result.result : result.subtype}` };
    }
    let raw: unknown = result.structured_output;
    if (raw === undefined) {
      try {
        raw = JSON.parse(result.result);
      } catch {
        return { ok: false as const, reason: "output is not valid JSON" };
      }
    }
    const parsed = parseHandoff(raw, { taskId: req.taskId, role: req.role });
    return parsed.ok ? parsed : { ok: false as const, reason: `invalid handoff: ${parsed.error}` };
  }
}
