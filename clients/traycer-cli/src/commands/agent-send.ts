import {
  sendAgentMessageRequestSchema,
  sendAgentMessageResponseSchema,
} from "@traycer/protocol/host/agent/shared";
import {
  callHostRpcWithDispatch,
  parseCanonicalHostResponse,
  parseUserInput,
  toAgentCliError,
  type HostRpcDispatch,
} from "../internal/host-rpc";
import { resolveEpicId, resolveSenderAgentId } from "../internal/agent-context";
import type { CommandFn } from "../runner/runner";

/**
 * The host answers this call once the receiver has DURABLY ACCEPTED the
 * message, and reaching that point means opening the receiving agent's chat
 * session when it is not already open. That open is the cost: on a loaded
 * machine it has been measured at 26s and 38s for one send, against the
 * transport's 15s default - so the deadline expired while the host was still
 * on its way to delivering, and the command reported a failure for a message
 * that then arrived. 60s covers the measured spread with room above it.
 *
 * It bounds the RESPONSE wait only. The dial and the handshake keep their own
 * deadlines, so a host that is genuinely not there still fails in seconds, and
 * the post-send attestation grace shrinks to its floor as this grows rather
 * than stacking on top of it.
 */
const SEND_MESSAGE_RESPONSE_TIMEOUT_MS = 60_000;
const SEND_MESSAGE_DISPATCH: HostRpcDispatch = {
  responseTimeoutMs: SEND_MESSAGE_RESPONSE_TIMEOUT_MS,
  requiredHostMethodVersion: null,
  signal: null,
  failFast: false,
};

/**
 * `traycer agent send` - hand a prompt to another agent
 * (`agent.sendMessage`).
 *
 *   - `--expect-reply` opens (or reuses) a thread keyed on the
 *     (sender, receiver) pair; the host returns a `responseId` identifying
 *     that outgoing thread for follow-ups from this sender.
 *   - `--response-id <id>` on a send with `--expect-reply` omitted answers a
 *     request received from that recipient. It is not the outgoing thread ID
 *     returned by your own `--expect-reply` send; omit it on your own
 *     follow-ups. Omit both for a one-shot, no-reply message.
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
      callHostRpcWithDispatch(
        "agent.sendMessage",
        request,
        SEND_MESSAGE_DISPATCH,
      ),
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
