import {
  query,
  type SDKAssistantMessageError,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { redact } from "../redact.ts";
import {
  claudeFailure,
  claudeProcess,
  classifyCredentials,
  credentialAction,
  modelIdentifier,
  withTimeout,
} from "./readiness.ts";

const initializeTimeoutMs = 60_000;

/** Why an execution failed, in terms the parent agent can act on. */
export type FailureReason =
  | "authentication"
  | "subscription_limit"
  | "invalid_request"
  | "session_unavailable"
  | "provider_error";

export interface ExecutionRequest {
  executable: string;
  env: NodeJS.ProcessEnv;
  extraArgs: Record<string, string>;
  cwd: string;
  prompt: string;
  /** Appended to Claude Code's system prompt: the task profile and reporting contract. */
  guidance: string;
  disallowedTools: string[];
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Session to continue; the prompt is sent only if Claude Code can resume it. */
  resume?: string;
  /** Aborting stops Claude Code; the outcome is then `cancelled`. */
  signal: AbortSignal;
  secrets: readonly string[];
}

export interface ExecutionObserver {
  session(id: string): void;
  /** Called with the reset time while Claude Code waits for subscription capacity, and with undefined once it proceeds. */
  capacity(waiting: { resetsAt?: number } | undefined): void;
  /** Text Claude writes while it works. */
  message(text: string): void;
  /** A tool Claude calls, with its input as Claude sent it. */
  toolCall(name: string, input: unknown): void;
}

type TurnOutcome =
  | { status: "completed"; text: string; structured?: unknown }
  | { status: "cancelled" }
  | {
      status: "failed";
      reason: FailureReason;
      message: string;
      action: string;
      detail?: { resetsAt?: number };
    };

/** `processExited` confirms that the Claude Code process is gone, whatever the outcome. */
export type ExecutionOutcome = TurnOutcome & { processExited: boolean };

/** The shape Claude Code must return its final answer in. */
export const reportedResult = z.object({
  summary: z.string().describe("The answer or outcome of the assignment."),
  evidence: z.array(z.string()).describe("What was inspected or run, and what it showed."),
  failures: z.array(z.string()).describe("Anything that failed or could not be verified."),
  remainingWork: z.array(z.string()).describe("Work left for the parent agent."),
});
// Claude Code validates --json-schema with a draft-07 validator.
const resultSchema = z.toJSONSchema(reportedResult, { target: "draft-7" });

const accountErrors = new Set<SDKAssistantMessageError>([
  "authentication_failed",
  "oauth_org_not_allowed",
  "account_on_hold",
  "verification_required",
  "billing_error",
  "cloud_credential_error",
]);

const assistantErrors = new Set<SDKAssistantMessageError>([
  ...accountErrors,
  "rate_limit",
  "overloaded",
  "invalid_request",
  "model_not_found",
  "server_error",
  "unknown",
  "max_output_tokens",
]);
const resultSubtypes = new Set([
  "success",
  "error_during_execution",
  "error_max_turns",
  "error_max_budget_usd",
  "error_max_structured_output_retries",
]);
const sessionIdentifier = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How a turn ended, from the assistant error code and result subtype the bridge knows. */
function turnFailure(error: string | undefined, subtype: string): string {
  const reported =
    error === undefined
      ? ""
      : assistantErrors.has(error as SDKAssistantMessageError)
        ? `reported ${error} and `
        : "reported an unrecognized error and ";
  const ending =
    subtype === "success"
      ? "an error result"
      : resultSubtypes.has(subtype)
        ? subtype
        : "an unrecognized result";
  return `Claude Code ${reported}ended the turn with ${ending}`;
}

function failureReason(error: SDKAssistantMessageError | undefined): FailureReason {
  if (error && accountErrors.has(error)) return "authentication";
  if (error === "rate_limit") return "subscription_limit";
  if (error === "model_not_found" || error === "invalid_request") return "invalid_request";
  return "provider_error";
}

/** Streaming input for one prompt, sent only after the session is verified. */
class Input implements AsyncIterable<SDKUserMessage> {
  private readonly messages: SDKUserMessage[] = [];
  private wake?: () => void;
  private closed = false;

  push(text: string): void {
    this.messages.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
    });
    this.wake?.();
  }

  close(): void {
    this.closed = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      const next = this.messages.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => (this.wake = resolve));
    }
  }
}

/**
 * Runs one prompt through Claude Code. The session's credential source and the
 * requested model are checked before the prompt is sent, so a rejected
 * execution never reaches a model. A failure is described only by values the
 * bridge knows (the reason, an assistant error code, a result subtype, the
 * process's exit, a timeout, a reset time): text from Claude Code, the SDK, or
 * an MCP server can quote credentials in forms no filter recognizes. Every
 * outcome is returned only after Claude Code's process has exited.
 */
export async function runExecution(
  request: ExecutionRequest,
  observer: ExecutionObserver,
): Promise<ExecutionOutcome> {
  const input = new Input();
  const abort = new AbortController();
  if (request.signal.aborted) return { status: "cancelled", processExited: true };
  const claude = claudeProcess();
  const cancel = () => abort.abort();
  request.signal.addEventListener("abort", cancel, { once: true });
  let sessionId: string | undefined;
  const failed = (
    reason: FailureReason,
    description: string,
    action: string,
    detail?: { resetsAt: number },
  ): TurnOutcome => ({
    status: "failed",
    reason,
    message: redact(
      `Execution failed with ${reason}: ${description}.${detail ? ` Subscription capacity resets at ${new Date(detail.resetsAt * 1000).toISOString()}.` : ""}`,
      request.secrets,
    ),
    action,
    ...(detail ? { detail } : {}),
  });
  // Claude Code's full output stays on the user's screen instead of in the bridge.
  const inspect = () =>
    sessionId
      ? `Run \`claude\` in ${request.cwd} and enter \`/resume ${sessionId}\` to see Claude Code's full output, then start a new task with a new request key once the problem is fixed.`
      : `Run \`claude\` in ${request.cwd} to see whether Claude Code starts and is signed in, then start a new task with a new request key.`;
  const session = query({
    prompt: input,
    options: {
      pathToClaudeCodeExecutable: request.executable,
      cwd: request.cwd,
      env: request.env,
      extraArgs: request.extraArgs,
      abortController: abort,
      // Spawning here gives the bridge the process itself, so its exit can be
      // confirmed and a failure described by it rather than by its output.
      spawnClaudeCodeProcess: claude.spawn,
      ...(request.model ? { model: request.model } : {}),
      ...(request.effort ? { effort: request.effort } : {}),
      ...(request.resume ? { resume: request.resume } : {}),
      permissionMode: "default",
      disallowedTools: request.disallowedTools,
      canUseTool: async (tool, toolInput) =>
        tool === "AskUserQuestion"
          ? {
              behavior: "deny",
              message:
                "No one can answer questions during this task. Make a reasonable assumption, state it, and list open questions as remaining work.",
            }
          : { behavior: "allow", updatedInput: toolInput },
      outputFormat: { type: "json_schema", schema: resultSchema },
      systemPrompt: { type: "preset", preset: "claude_code", append: request.guidance },
    },
  });
  const turn = async (): Promise<TurnOutcome> => {
    try {
      let init;
      try {
        init = await withTimeout(session.initializationResult(), initializeTimeoutMs);
      } catch (error) {
        if (request.resume && /no conversation found/i.test((error as Error).message)) {
          return failed(
            "session_unavailable",
            `Claude Code cannot resume session ${request.resume}; the message was not sent`,
            "Start a new task with the context the follow-up needs; the earlier results stay available.",
          );
        }
        throw error;
      }
      const credentials = classifyCredentials(init.account);
      if (!credentials.verified) {
        return failed(
          "authentication",
          `Claude Code is not using a verified subscription login (source: ${credentials.source}); the brief was not sent`,
          credentialAction(credentials) ?? inspect(),
        );
      }
      if (
        request.model &&
        !init.models.some(
          (model) => model.value === request.model || model.resolvedModel === request.model,
        )
      ) {
        const available = init.models
          .map((model) => model.value)
          .filter((value) => modelIdentifier.test(value));
        return failed(
          "invalid_request",
          `model ${request.model} is not available in Claude Code (available: ${available.join(", ")}); the brief was not sent`,
          "Choose a model from the readiness `models`, or omit `model` to use Claude Code's default.",
        );
      }

      if (request.signal.aborted) return { status: "cancelled" };
      input.push(request.prompt);
      let lastError: SDKAssistantMessageError | undefined;
      let resetsAt: number | undefined;
      for await (const message of session) {
        if (message.type === "system" && message.subtype === "init") {
          if (sessionIdentifier.test(message.session_id)) sessionId = message.session_id;
          observer.session(message.session_id);
        } else if (message.type === "rate_limit_event") {
          const info = message.rate_limit_info;
          if (info.status === "rejected") {
            resetsAt = info.resetsAt;
            observer.capacity(resetsAt === undefined ? {} : { resetsAt });
          } else {
            observer.capacity(undefined);
          }
        } else if (message.type === "assistant") {
          if (message.error) lastError = message.error;
          for (const block of message.message.content) {
            if (block.type === "text" && block.text.trim()) {
              observer.message(block.text);
            } else if (block.type === "tool_use") {
              observer.toolCall(block.name, block.input);
            }
          }
        } else if (message.type === "result") {
          if (message.subtype === "success" && !message.is_error) {
            return {
              status: "completed",
              text: message.result,
              ...(message.structured_output === undefined
                ? {}
                : { structured: message.structured_output }),
            };
          }
          const reason = failureReason(lastError);
          const description = turnFailure(lastError, message.subtype);
          if (reason === "authentication") {
            return failed(
              reason,
              description,
              "Run `claude`, then `/login` with your Claude subscription account.",
            );
          }
          if (reason === "subscription_limit") {
            return failed(
              reason,
              description,
              "Wait until subscription capacity resets, then start a new task with a new request key.",
              typeof resetsAt === "number" && !Number.isNaN(new Date(resetsAt * 1000).getTime())
                ? { resetsAt }
                : undefined,
            );
          }
          return failed(reason, description, inspect());
        }
      }
      if (request.signal.aborted) return { status: "cancelled" };
      return failed(
        "provider_error",
        claudeFailure(undefined, await claude.exit(), initializeTimeoutMs),
        inspect(),
      );
    } catch (error) {
      if (request.signal.aborted) return { status: "cancelled" };
      return failed(
        "provider_error",
        claudeFailure(error, await claude.exit(), initializeTimeoutMs),
        inspect(),
      );
    } finally {
      request.signal.removeEventListener("abort", cancel);
    }
  };
  const outcome = await turn();
  input.close();
  session.close();
  const processExited = await claude.stop();
  abort.abort();
  return { ...outcome, processExited };
}
