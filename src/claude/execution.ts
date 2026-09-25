import {
  query,
  type SDKAssistantMessageError,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { spawn, type ChildProcess } from "node:child_process";
import { z } from "zod";
import { redact } from "../redact.ts";
import { classifyCredentials, credentialAction, withTimeout } from "./readiness.ts";

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
  /** The operating-system process of Claude Code, known once it has started. */
  process(pid: number): void;
  session(id: string): void;
  /** Called with the reset time while Claude Code waits for subscription capacity, and with undefined once it proceeds. */
  capacity(waiting: { resetsAt?: number } | undefined): void;
  /** Text Claude writes while it works. */
  message(text: string): void;
  /** A tool Claude calls, with its input as Claude sent it. */
  toolCall(name: string, input: unknown): void;
}

export type ExecutionOutcome =
  | { status: "completed"; text: string; structured?: unknown }
  /** `processExited` confirms that the Claude Code process is gone. */
  | { status: "cancelled"; processExited: boolean }
  | {
      status: "failed";
      reason: FailureReason;
      message: string;
      action?: string;
      detail?: { resetsAt?: number };
    };

/** The shape Claude Code must return its final answer in. */
export const reportedResult = z.object({
  summary: z.string().describe("The answer or outcome of the assignment."),
  evidence: z.array(z.string()).describe("What was inspected or run, and what it showed."),
  failures: z.array(z.string()).describe("Anything that failed or could not be verified."),
  remainingWork: z.array(z.string()).describe("Work left for the parent agent."),
});
const resultSchema = z.toJSONSchema(reportedResult);

const accountErrors = new Set<SDKAssistantMessageError>([
  "authentication_failed",
  "oauth_org_not_allowed",
  "account_on_hold",
  "verification_required",
  "billing_error",
  "cloud_credential_error",
]);

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

/** Whether `event` settles within `ms`. */
function within(event: Promise<void>, ms: number): Promise<boolean> {
  return Promise.race([
    event.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
  ]);
}

/**
 * Runs one prompt through Claude Code. The session's credential source and the
 * requested model are checked before the prompt is sent, so a rejected
 * execution never reaches a model.
 */
export async function runExecution(
  request: ExecutionRequest,
  observer: ExecutionObserver,
): Promise<ExecutionOutcome> {
  const stderr: string[] = [];
  const input = new Input();
  const abort = new AbortController();
  if (request.signal.aborted) return { status: "cancelled", processExited: true };
  const cancel = () => abort.abort();
  request.signal.addEventListener("abort", cancel, { once: true });
  let child: ChildProcess | undefined;
  let exited: Promise<void> = Promise.resolve();
  const failed = (
    reason: FailureReason,
    message: string,
    extra: object = {},
  ): ExecutionOutcome => ({
    status: "failed",
    reason,
    message: redact(message, request.secrets),
    ...extra,
  });
  const session = query({
    prompt: input,
    options: {
      pathToClaudeCodeExecutable: request.executable,
      cwd: request.cwd,
      env: request.env,
      extraArgs: request.extraArgs,
      abortController: abort,
      // Spawning here gives the bridge the process itself, so termination can be confirmed.
      spawnClaudeCodeProcess: (options) => {
        const process = spawn(options.command, options.args, {
          cwd: options.cwd,
          env: options.env as NodeJS.ProcessEnv,
          stdio: ["pipe", "pipe", "pipe"],
          signal: options.signal,
        });
        child = process;
        exited = new Promise((resolve) => {
          process.once("exit", () => resolve());
          process.once("error", () => resolve());
        });
        process.stderr.on("data", (data: Buffer) => {
          stderr.push(data.toString());
          if (stderr.length > 50) stderr.shift();
        });
        if (process.pid) observer.process(process.pid);
        return process;
      },
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
  const diagnostics = () => stderr.join("").trim();
  const cancelled = async (): Promise<ExecutionOutcome> => {
    session.close();
    let processExited = await within(exited, 10_000);
    if (!processExited && child) {
      child.kill("SIGKILL");
      processExited = await within(exited, 5_000);
    }
    return { status: "cancelled", processExited };
  };
  try {
    let init;
    try {
      init = await withTimeout(session.initializationResult(), initializeTimeoutMs);
    } catch (error) {
      if (request.resume && /no conversation found/i.test((error as Error).message)) {
        return failed(
          "session_unavailable",
          `Claude Code cannot resume session ${request.resume}; the message was not sent.`,
          {
            action:
              "Start a new task with the context the follow-up needs; the earlier results stay available.",
          },
        );
      }
      throw error;
    }
    const credentials = classifyCredentials(init.account);
    if (!credentials.verified) {
      return failed(
        "authentication",
        `Claude Code is not using a verified subscription login (source: ${credentials.source}); the brief was not sent.`,
        { action: credentialAction(credentials) },
      );
    }
    if (
      request.model &&
      !init.models.some(
        (model) => model.value === request.model || model.resolvedModel === request.model,
      )
    ) {
      return failed(
        "invalid_request",
        `Model ${request.model} is not available in Claude Code; the brief was not sent. Available: ${init.models.map((model) => model.value).join(", ")}.`,
      );
    }

    if (request.signal.aborted) return await cancelled();
    input.push(request.prompt);
    let lastError: SDKAssistantMessageError | undefined;
    let resetsAt: number | undefined;
    for await (const message of session) {
      if (message.type === "system" && message.subtype === "init") {
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
        const text =
          message.subtype === "success" ? message.result : message.errors?.join("; ") || "";
        return failed(reason, text || `Claude Code ended the turn with ${message.subtype}.`, {
          ...(reason === "subscription_limit" && resetsAt !== undefined
            ? { detail: { resetsAt } }
            : {}),
          ...(reason === "authentication"
            ? { action: "Run `claude`, then `/login` with your Claude subscription account." }
            : {}),
        });
      }
    }
    if (request.signal.aborted) return await cancelled();
    return failed("provider_error", `Claude Code exited without a result. ${diagnostics()}`.trim());
  } catch (error) {
    if (request.signal.aborted) return await cancelled();
    return failed(
      "provider_error",
      [(error as Error).message, diagnostics()].filter(Boolean).join(" — "),
    );
  } finally {
    request.signal.removeEventListener("abort", cancel);
    input.close();
    session.close();
    abort.abort();
  }
}
