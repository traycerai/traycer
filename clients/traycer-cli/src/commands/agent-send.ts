import {
  A2A_MESSAGE_MAX_UTF8_BYTES,
  sendAgentMessageRequestSchema,
  sendAgentMessageResponseSchema,
  utf8ByteLength,
} from "@traycer/protocol/host/agent/shared";
import { createReadStream } from "node:fs";
import {
  callHostRpc,
  parseCanonicalHostResponse,
  parseUserInput,
  toAgentCliError,
} from "../internal/host-rpc";
import { resolveEpicId, resolveSenderAgentId } from "../internal/agent-context";
import { cliError, CLI_ERROR_CODES } from "../runner/errors";
import type { CommandFn } from "../runner/runner";

interface AgentSendPromptOptions {
  readonly message: string | null;
  readonly messageFile: string | null;
  readonly stdin: boolean;
}

interface BoundedPromptInput {
  readonly stream: AsyncIterable<Buffer | string>;
  readonly stop: () => void;
  readonly readErrorMessage: string;
  readonly invalidUtf8Message: string;
}

/**
 * `traycer agent send` - hand a prompt to another agent
 * (`agent.sendMessage`).
 *
 *   - `--expect-reply` opens (or reuses) a thread keyed on the
 *     (sender, receiver) pair; the host returns a `responseId` the
 *     receiver echoes back on its final reply.
 *   - `--response-id <id>` on a send with `--expect-reply` omitted is
 *     the final reply that closes that thread; omit both for a
 *     one-shot, no-reply message.
 */
export function buildAgentSendCommand(opts: {
  readonly epicId: string | null;
  readonly senderAgentId: string | null;
  readonly to: string;
  readonly message: string | null;
  readonly messageFile: string | null;
  readonly stdin: boolean;
  readonly expectReply: boolean;
  readonly responseId: string | null;
}): CommandFn {
  return async () => {
    const prompt = await resolvePrompt(opts);
    const request = parseUserInput(sendAgentMessageRequestSchema, {
      senderAgentId: resolveSenderAgentId(opts.senderAgentId),
      epicId: resolveEpicId(opts.epicId),
      receiverAgentId: opts.to,
      prompt,
      responseId: opts.responseId,
      expectReply: opts.expectReply,
    });
    const result = await toAgentCliError(
      callHostRpc("agent.sendMessage", request),
    );
    const { responseId } = parseCanonicalHostResponse(
      "agent.sendMessage",
      sendAgentMessageResponseSchema,
      result,
    );
    const human =
      responseId === null
        ? `sent to ${opts.to}`
        : `sent to ${opts.to} (responseId: ${responseId})`;
    return { data: { responseId }, human, exitCode: 0 };
  };
}

async function resolvePrompt(opts: AgentSendPromptOptions): Promise<string> {
  const sourceCount = [
    opts.message !== null,
    opts.messageFile !== null,
    opts.stdin,
  ].filter(Boolean).length;
  if (sourceCount !== 1) {
    throw cliError({
      code: CLI_ERROR_CODES.INVALID_ARGUMENT,
      message:
        "traycer agent send: exactly one of --message, --message-file, or --stdin is required.",
      details: null,
      exitCode: 1,
    });
  }

  if (opts.message !== null) return validatePromptSize(opts.message);
  if (opts.messageFile !== null) {
    const stream = createReadStream(opts.messageFile, {
      // `end` is inclusive: this caps the read at limit + 1 bytes, which is
      // enough to distinguish an accepted prompt from an oversized one.
      end: A2A_MESSAGE_MAX_UTF8_BYTES,
    });
    return readBoundedPrompt({
      stream,
      stop: () => stream.destroy(),
      readErrorMessage: "traycer agent send: could not read --message-file.",
      invalidUtf8Message:
        "traycer agent send: --message-file must contain valid UTF-8.",
    });
  }
  return readPromptFromStdin();
}

async function readPromptFromStdin(): Promise<string> {
  if (process.stdin.isTTY === true) {
    throw cliError({
      code: CLI_ERROR_CODES.INVALID_ARGUMENT,
      message: "traycer agent send: --stdin requires piped input.",
      details: null,
      exitCode: 1,
    });
  }

  return readBoundedPrompt({
    stream: process.stdin,
    stop: () => process.stdin.destroy(),
    readErrorMessage:
      "traycer agent send: could not read the prompt from stdin.",
    invalidUtf8Message:
      "traycer agent send: the prompt from stdin must contain valid UTF-8.",
  });
}

async function readBoundedPrompt(input: BoundedPromptInput): Promise<string> {
  const captureLimit = A2A_MESSAGE_MAX_UTF8_BYTES + 1;
  let captured = Buffer.allocUnsafe(Math.min(64 * 1024, captureLimit));
  let capturedBytes = 0;
  let oversized = false;
  try {
    for await (const chunk of input.stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const targetBytes = Math.min(captureLimit, capturedBytes + bytes.length);
      if (targetBytes > captured.length) {
        // Grow geometrically so a producer yielding tiny chunks cannot create
        // millions of retained Buffer objects before reaching the byte limit.
        let nextCapacity = captured.length;
        while (nextCapacity < targetBytes) {
          nextCapacity = Math.min(captureLimit, nextCapacity * 2);
        }
        const grown = Buffer.allocUnsafe(nextCapacity);
        captured.copy(grown, 0, 0, capturedBytes);
        captured = grown;
      }
      capturedBytes += bytes.copy(
        captured,
        capturedBytes,
        0,
        targetBytes - capturedBytes,
      );
      if (capturedBytes > A2A_MESSAGE_MAX_UTF8_BYTES) {
        oversized = true;
        try {
          input.stop();
        } catch {
          // Best effort: the overflow result still wins over cleanup failure.
        }
        break;
      }
    }
  } catch {
    if (!oversized) {
      throw cliError({
        code: CLI_ERROR_CODES.INVALID_ARGUMENT,
        message: input.readErrorMessage,
        details: null,
        exitCode: 1,
      });
    }
  }

  if (oversized) throw promptTooLargeError();
  let prompt: string;
  try {
    prompt = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      captured.subarray(0, capturedBytes),
    );
  } catch {
    throw cliError({
      code: CLI_ERROR_CODES.INVALID_ARGUMENT,
      message: input.invalidUtf8Message,
      details: null,
      exitCode: 1,
    });
  }
  return validatePromptSize(prompt);
}

function validatePromptSize(prompt: string): string {
  if (utf8ByteLength(prompt) > A2A_MESSAGE_MAX_UTF8_BYTES) {
    throw promptTooLargeError();
  }
  return prompt;
}

function promptTooLargeError() {
  return cliError({
    code: CLI_ERROR_CODES.INVALID_ARGUMENT,
    message: `traycer agent send: prompt exceeds the ${A2A_MESSAGE_MAX_UTF8_BYTES}-byte UTF-8 limit.`,
    details: null,
    exitCode: 1,
  });
}
