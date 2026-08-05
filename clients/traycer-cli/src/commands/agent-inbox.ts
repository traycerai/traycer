import { formatAgentMessageSenderLabel } from "@traycer/protocol/agent/a2a-message-format";
import { agentInboxReadResponseSchemaV20 } from "@traycer/protocol/host/agent/inbox";
import {
  callHostRpc,
  parseHostResponse,
  toAgentCliError,
} from "../internal/host-rpc";
import { resolveEpicId, resolveSenderAgentId } from "../internal/agent-context";
import type { CommandFn } from "../runner/runner";
import { CLI_ERROR_CODES, cliError } from "../runner/errors";

/**
 * `traycer agent inbox` - print the calling agent's recently-delivered
 * inbox messages in full (`agent.inbox.read`).
 *
 * The `traycer monitor` stream surfaces each inbound message through a
 * harness background-output notification, which the harness truncates for
 * large payloads. This command re-reads one durable inbox page over a plain
 * RPC, so its stdout carries the complete body without allocating a complete
 * backlog - the recovery path when a monitored message arrived clipped.
 *
 * `--agent-id` defaults to `$TRAYCER_AGENT_ID`; the epic is always read from
 * `$TRAYCER_EPIC_ID`, so an agent normally runs it with no flags.
 */
export function buildAgentInboxCommand(opts: {
  readonly epicId: string | null;
  readonly agentId: string | null;
  readonly after: string | null;
}): CommandFn {
  return async () => {
    const epicId = resolveEpicId(opts.epicId);
    const agentId = resolveSenderAgentId(opts.agentId);
    const after = parseCursor(opts.after);
    const result = await toAgentCliError(
      callHostRpc("agent.inbox.read", { epicId, agentId, after }),
    );
    const { messages, nextCursor } = parseHostResponse(
      agentInboxReadResponseSchemaV20,
      result,
    );
    if (messages.length === 0) {
      return {
        data: { messages, nextCursor },
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
    const nextPage =
      nextCursor === null
        ? ""
        : `\n\nMore inbox messages remain. Continue with: traycer agent inbox --after ${String(nextCursor.createdAt)}:${nextCursor.eventId}`;
    return {
      data: { messages, nextCursor },
      human: `${human}${nextPage}`,
      exitCode: 0,
    };
  };
}

function parseCursor(value: string | null): {
  readonly createdAt: number;
  readonly eventId: string;
} | null {
  if (value === null) return null;
  const separator = value.indexOf(":");
  const createdAt = Number(value.slice(0, separator));
  const eventId = value.slice(separator + 1);
  if (
    separator <= 0 ||
    !Number.isInteger(createdAt) ||
    createdAt < 0 ||
    eventId.length === 0
  ) {
    throw cliError({
      code: CLI_ERROR_CODES.INVALID_ARGUMENT,
      message:
        "traycer: --after must use the createdAt:eventId cursor returned by the prior inbox page",
      details: null,
      exitCode: 1,
    });
  }
  return { createdAt, eventId };
}
