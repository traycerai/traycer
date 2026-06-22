import { formatAgentMessageSenderLabel } from "@traycer/protocol/agent/a2a-message-format";
import { agentInboxReadResponseSchema } from "@traycer/protocol/host/agent/inbox";
import {
  callHostRpc,
  parseHostResponse,
  toAgentCliError,
} from "../internal/host-rpc";
import { resolveEpicId, resolveSenderAgentId } from "../internal/agent-context";
import type { CommandFn } from "../runner/runner";

/**
 * `traycer agent inbox` - print the calling agent's recently-delivered
 * inbox messages in full (`agent.inbox.read`).
 *
 * The `traycer monitor` stream surfaces each inbound message through a
 * harness background-output notification, which the harness truncates for
 * large payloads. This command re-reads the broker's retained ring over a
 * plain RPC, so its stdout carries the complete bodies - the recovery path
 * when a monitored message arrived clipped.
 *
 * `--agent-id` / `--epic-id` default to `$TRAYCER_AGENT_ID` /
 * `$TRAYCER_EPIC_ID`, so an agent normally runs it with no flags.
 */
export function buildAgentInboxCommand(opts: {
  readonly epicId: string | null;
  readonly agentId: string | null;
}): CommandFn {
  return async () => {
    const epicId = resolveEpicId(opts.epicId);
    const agentId = resolveSenderAgentId(opts.agentId);
    const result = await toAgentCliError(
      callHostRpc("agent.inbox.read", { epicId, agentId }),
    );
    const { messages } = parseHostResponse(
      agentInboxReadResponseSchema,
      result,
    );
    if (messages.length === 0) {
      return {
        data: { messages },
        human: "No recent inbox messages.",
        exitCode: 0,
      };
    }
    const human = messages
      .map((message) => {
        const sender = formatAgentMessageSenderLabel({
          agentId: message.fromAgentId,
          title: message.senderTitle,
          harnessId: message.senderHarnessId,
        });
        const reply = message.reply.expectsReply
          ? ` — reply with: traycer agent send --to ${message.fromAgentId} --response-id ${message.reply.responseId} --message "<reply>"`
          : "";
        return `── message from ${sender}${reply} ──\n${message.prompt}`;
      })
      .join("\n\n");
    return { data: { messages }, human, exitCode: 0 };
  };
}
