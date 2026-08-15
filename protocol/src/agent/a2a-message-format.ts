export type AgentMessageReceiverChannel = "gui" | "cli";

export type AgentMessageReply =
  | {
      readonly expectsReply: true;
      readonly responseId: string;
    }
  | {
      readonly expectsReply: false;
    };

export interface AgentMessageSenderDisplay {
  readonly agentId: string;
  readonly title: string | null;
  readonly harnessId: string | null;
}

export interface FormatAgentMessageInput {
  readonly receiverChannel: AgentMessageReceiverChannel;
  readonly sender: AgentMessageSenderDisplay;
  readonly reply: AgentMessageReply;
  readonly body: string;
}

/**
 * One body for both channels. Every A2A-capable agent — GUI turn or terminal
 * launch — is handed the same host-owned `traycer_a2a` MCP catalog, so the
 * reply instruction names `traycer_send_message` on both. The `cli` channel
 * discriminator survives only as a transport/rendering marker; it must never
 * steer a model back to the `traycer agent …` CLI, which stays implemented for
 * humans and lifecycle hooks but is no longer advertised to models.
 */
export function formatAgentMessage(input: FormatAgentMessageInput): string {
  switch (input.receiverChannel) {
    case "gui":
    case "cli":
      return formatToolAddressedAgentMessage(input);
    default: {
      const _exhaustiveCheck: never = input.receiverChannel;
      throw new Error(`Unhandled agent message channel: ${_exhaustiveCheck}`);
    }
  }
}

function formatToolAddressedAgentMessage(
  input: FormatAgentMessageInput,
): string {
  const replyLine = input.reply.expectsReply
    ? `[traycer:agent-message] A reply is expected. Use the traycer_send_message tool to reply with responseId="${input.reply.responseId}".
[traycer:agent-message] The responseId names this sender's thread, not this single message: follow-up messages may arrive with the same responseId, and one reply with it answers everything on the thread. Only a reply carrying the responseId completes the request — a fresh message does not.`
    : "[traycer:agent-message] No reply is required.";

  return `[traycer:agent-message] from ${formatAgentMessageSenderLabel(input.sender)}
${replyLine}

${input.body}`;
}

export function formatAgentMessageSenderLabel(
  sender: AgentMessageSenderDisplay,
): string {
  const senderName =
    sender.title !== null
      ? `${sender.title} (agent ${sender.agentId})`
      : `agent ${sender.agentId}`;
  const harnessSuffix =
    sender.harnessId !== null ? ` [${sender.harnessId}]` : "";
  return `${senderName}${harnessSuffix}`;
}
