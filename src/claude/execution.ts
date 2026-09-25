import {
  query,
  type SDKAssistantMessageError,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { redact } from "../redact.ts";
import { classifyCredentials, credentialAction, withTimeout } from "./readiness.ts";

const initializeTimeoutMs = 60_000;

/** Why an execution failed, in terms the parent agent can act on. */
export type FailureReason =
  | "authentication"
  | "subscription_limit"
  | "invalid_request"
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
  secrets: readonly string[];
}

export interface ExecutionObserver {
  session(id: string): void;
  /** Called with the reset time while Claude Code waits for subscription capacity, and with undefined once it proceeds. */
  capacity(waiting: { resetsAt?: number } | undefined): void;
}

export type ExecutionOutcome =
  | { status: "completed"; text: string; structured?: unknown }
  | {
      status: "failed";
      reason: FailureReason;
      message: string;
      action?: string;
      detail?: { resetsAt?: number };
    };

/** The shape Claude Code must return its final answer in. */
export const resultSchema = {
  type: "object",
  properties: {
    summary: { type: "string", description: "The answer or outcome of the assignment." },
    evidence: {
      type: "array",
      items: { type: "string" },
      description: "What was inspected or run, and what it showed.",
    },
    failures: {
      type: "array",
      items: { type: "string" },
      description: "Anything that failed or could not be verified.",
    },
    remainingWork: {
      type: "array",
      items: { type: "string" },
      description: "Work left for the parent agent.",
    },
  },
  required: ["summary", "evidence", "failures", "remainingWork"],
  additionalProperties: false,
};

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
      stderr: (data) => {
        stderr.push(data);
        if (stderr.length > 50) stderr.shift();
      },
      ...(request.model ? { model: request.model } : {}),
      ...(request.effort ? { effort: request.effort } : {}),
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
  try {
    const init = await withTimeout(session.initializationResult(), initializeTimeoutMs);
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
    return failed("provider_error", `Claude Code exited without a result. ${diagnostics()}`.trim());
  } catch (error) {
    return failed(
      "provider_error",
      [(error as Error).message, diagnostics()].filter(Boolean).join(" — "),
    );
  } finally {
    input.close();
    session.close();
    abort.abort();
  }
}
