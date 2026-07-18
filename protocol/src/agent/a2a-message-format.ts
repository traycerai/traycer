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

export function formatAgentMessage(input: FormatAgentMessageInput): string {
  switch (input.receiverChannel) {
    case "gui":
      return formatGuiAgentMessage(input);
    case "cli":
      return formatCliAgentMessage(input);
    default: {
      const _exhaustiveCheck: never = input.receiverChannel;
      throw new Error(`Unhandled agent message channel: ${_exhaustiveCheck}`);
    }
  }
}

function formatGuiAgentMessage(input: FormatAgentMessageInput): string {
  const replyLine = input.reply.expectsReply
    ? `[traycer:agent-message] A reply is expected. Use the traycer_send_message tool to reply with responseId="${input.reply.responseId}".
[traycer:agent-message] The responseId names this sender's thread, not this single message: follow-up messages may arrive with the same responseId, and one reply with it answers everything on the thread. Only a reply carrying the responseId completes the request — a fresh message does not.`
    : "[traycer:agent-message] No reply is required.";

  return `[traycer:agent-message] from ${formatAgentMessageSenderLabel(input.sender)}
${replyLine}

${input.body}`;
}

function formatCliAgentMessage(input: FormatAgentMessageInput): string {
  const responseHint = input.reply.expectsReply
    ? ` — responseId ${input.reply.responseId}`
    : "";
  const header = `[traycer inbox] message from ${formatAgentMessageSenderLabel(input.sender)}${responseHint}`;

  if (input.reply.expectsReply) {
    return `
${header}
[traycer inbox] a reply is expected — reply with: traycer agent send --to ${input.sender.agentId} --response-id ${input.reply.responseId} --message "<your reply>"
[traycer inbox] the response id names this sender's thread, not this single message — follow-ups may arrive with the same id and one reply with it answers them all; only a reply sent with --response-id completes the request

${input.body}
[traycer inbox] ─── end of message ───
[traycer inbox] if the message above looks cut off, read it in full with: traycer agent inbox`;
  }

  return `
${header}

${input.body}
[traycer inbox] ─── end of message ───
[traycer inbox] if the message above looks cut off, read it in full with: traycer agent inbox`;
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
