import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Options, PermissionMode, SDKMessage, SDKResultMessage, SettingSource } from "@anthropic-ai/claude-agent-sdk";
import type { Db } from "../db/index.js";
import { UNKNOWN_RESET_MS, type QuotaService, type RateLimitInfo } from "../core/quota.js";
import { toolCallsOf, type ActivityService } from "../core/activity.js";
import type { TaskService } from "../core/tasks.js";
import { handoffJsonSchema, parseHandoff, type AgentRole, type Handoff } from "./contract.js";

export type QueryFn = (params: { prompt: string; options: Options }) => AsyncIterable<SDKMessage>;

export interface RunRequest {
  /** The task this call belongs to. `null` for calls that belong to no task (the operator chat): handoffs then carry task_id "0". */
  taskId: number | null;
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
  /** In-process MCP servers (the operator's tools). Agents get none by default. */
  mcpServers?: Options["mcpServers"];
  /** Extra folders the agent may read besides its working directory (the owner's attached files). */
  extraDirs?: string[];
  /** Settings files to load. Default none: cheaper, and the agent does not pick up personal settings. */
  settingSources?: SettingSource[];
  permissionMode?: PermissionMode;
  maxTurns?: number;
  /** True when this call is the first one after an escalation; recorded in llm_calls. */
  escalated?: boolean;
  signal?: AbortSignal;
}

export type RunResult =
  | { ok: true; handoff: Handoff; tokens: number }
  /** `quotaUntil`: the subscription refused the call because its quota is used up, until then. Not the agent's failure. */
  | { ok: false; reason: string; tokens: number; quotaUntil?: Date };

const defaultQuery: QueryFn = async function* (params) {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  yield* query(params);
};

/** Tokens that count against the task cap: fresh input, cache writes and output. Cache reads are excluded. */
export function countTokens(result: SDKResultMessage): number {
  return Object.values(result.modelUsage ?? {}).reduce((sum, m) => sum + m.inputTokens + m.outputTokens + m.cacheCreationInputTokens, 0);
}

/**
 * Environment variables an agent may see: only what the CLI needs to run and to log in to the Claude subscription.
 * An allowlist, so any new secret the core gets (tokens, VAPID keys) is hidden from agents by default.
 */
const AGENT_ENV_ALLOWED = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "TERM",
  "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS",
];

export function agentEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  return Object.fromEntries(AGENT_ENV_ALLOWED.filter((k) => env[k] !== undefined).map((k) => [k, env[k]]));
}

/**
 * The core's own files agents must not touch: the .env and the database files. Not the whole data folder:
 * the task worktrees live inside it and the builder has to work there.
 */
export function protectedPathsFor(dbPath: string, envFile = ".env"): string[] {
  const db = resolve(dbPath);
  return [resolve(envFile), db, `${db}-wal`, `${db}-shm`];
}

export class AgentRunner {
  /** `protectedPaths`: files and folders of the core itself (.env, database) that agents must never read. */
  constructor(private db: Db, private tasks: TaskService, private queryFn: QueryFn = defaultQuery, private activity?: ActivityService, private protectedPaths: string[] = [], private quota?: QuotaService) {}

  /** Runs one agent call, validates its output against the handoff contract and logs it to llm_calls. */
  async run(req: RunRequest): Promise<RunResult> {
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    req.signal?.addEventListener("abort", onAbort);

    let result: SDKResultMessage | undefined;
    let quotaUntil: Date | undefined;
    let outcome: { ok: true; handoff: Handoff } | { ok: false; reason: string };
    try {
      // The SDK reports a missing working directory as "binary failed to launch", which sends people hunting in the wrong place.
      if (!existsSync(req.cwd)) throw new Error(`working directory does not exist: ${req.cwd}`);
      const options: Options = {
        model: req.model,
        systemPrompt: req.systemPrompt,
        cwd: req.cwd,
        tools: req.tools,
        allowedTools: req.allowedTools,
        additionalDirectories: req.extraDirs,
        // "//abs/path" is the permission-rule syntax for an absolute path. Denied for every tool that can read files.
        disallowedTools: this.protectedPaths.flatMap((p) => [`Read(/${p})`, `Read(/${p}/**)`, `Edit(/${p})`, `Edit(/${p}/**)`]),
        permissionMode: req.permissionMode,
        maxTurns: req.maxTurns ?? 30,
        outputFormat: { type: "json_schema", schema: handoffJsonSchema },
        settingSources: req.settingSources ?? [],
        // Agents get no MCP servers and none of the account's claude.ai connectors. Left on, the connectors were loaded
        // as soon as an agent used a tool and grew a 3.5K-token context to ~120K, and they are tools agents must not have.
        strictMcpConfig: true,
        mcpServers: req.mcpServers ?? {},
        settings: { disableClaudeAiConnectors: true },
        abortController: abort,
        // Agents run on the Claude subscription (never an API key) and see none of the core's secrets: see agentEnv.
        env: agentEnv(),
      };
      for await (const message of this.queryFn({ prompt: req.prompt, options })) {
        if (message.type === "result") result = message;
        else if (message.type === "rate_limit_event") {
          const until = this.quota?.record(message.rate_limit_info as RateLimitInfo);
          if (until) quotaUntil = until;
        } else if (message.type === "assistant" && message.error === "rate_limit") {
          // A refusal without a report of when it ends: wait for the 5 hour window if it is known, otherwise a short while.
          quotaUntil ??= this.quota?.nextReset() ?? new Date(Date.now() + UNKNOWN_RESET_MS);
          this.quota?.block(quotaUntil);
        } else if (message.type === "assistant" && this.activity && req.taskId !== null) {
          for (const call of toolCallsOf(message, req.cwd)) this.activity.record(req.taskId, req.role, call.tool, call.target);
        }
      }
      outcome = result ? this.validate(result, req) : { ok: false, reason: "agent produced no result" };
    } catch (err) {
      outcome = { ok: false, reason: `agent call failed: ${(err as Error).message}` };
    } finally {
      req.signal?.removeEventListener("abort", onAbort);
    }

    const tokens = result ? countTokens(result) : 0;
    // A call the subscription refused used nothing and says nothing about the agent: it is not counted as a bad answer.
    if (quotaUntil && tokens === 0) return { ok: false, reason: "subscription quota used up", tokens, quotaUntil };
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
    if (req.taskId !== null) this.tasks.addTokens(req.taskId, tokens);
    return outcome.ok ? { ok: true, handoff: outcome.handoff, tokens } : { ok: false, reason: outcome.reason, tokens, ...(quotaUntil ? { quotaUntil } : {}) };
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
    const parsed = parseHandoff(raw, { taskId: req.taskId ?? 0, role: req.role });
    return parsed.ok ? parsed : { ok: false as const, reason: `invalid handoff: ${parsed.error}` };
  }
}
