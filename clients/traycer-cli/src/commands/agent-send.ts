import {
  sendAgentMessageRequestSchema,
  sendAgentMessageResponseSchema,
} from "@traycer/protocol/host/agent/shared";
import {
  callHostRpc,
  parseHostResponse,
  parseUserInput,
  toAgentCliError,
} from "../internal/host-rpc";
import { resolveEpicId, resolveSenderAgentId } from "../internal/agent-context";
import type { CommandFn } from "../runner/runner";

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
  readonly message: string;
  readonly expectReply: boolean;
  readonly responseId: string | null;
}): CommandFn {
  return async () => {
    const request = parseUserInput(sendAgentMessageRequestSchema, {
      senderAgentId: resolveSenderAgentId(opts.senderAgentId),
      epicId: resolveEpicId(opts.epicId),
      receiverAgentId: opts.to,
      prompt: opts.message,
      responseId: opts.responseId,
      expectReply: opts.expectReply,
    });
    const result = await toAgentCliError(
      callHostRpc("agent.sendMessage", request),
    );
    const { responseId } = parseHostResponse(
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
