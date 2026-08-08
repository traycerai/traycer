import {
  setChatArchivedRequestSchema,
  setChatArchivedResponseSchema,
} from "@traycer/protocol/host/epic/unary-schemas";
import {
  callHostRpc,
  parseHostResponse,
  parseUserInput,
  toAgentCliError,
} from "../internal/host-rpc";
import { resolveEpicId } from "../internal/agent-context";
import { cliError, CliError, CLI_ERROR_CODES } from "../runner/errors";
import type { CommandFn } from "../runner/runner";

// Reason prefixes the host rides on the generic `RPC_ERROR` message rather
// than a typed wire code - see `epic-set-chat-archived-resolver.ts`,
// `AgentArchiveBlockedError`, and `EpicChatRecordMissingError`. The 409-vs-500
// distinction never crosses the wire, so this is the only signal available.
const AGENT_BUSY_PREFIX = "AGENT_BUSY:";
const RECORD_NOT_FOUND_PREFIX = "RECORD_NOT_FOUND:";

/**
 * `traycer agent archive --agent-id <id> [--unarchive]` - toggle the durable
 * archive flag on a GUI chat or terminal agent (`epic.setChatArchived`). One
 * RPC covers both record kinds; the host resolves the id against chats first,
 * then terminal agents.
 *
 * Archived agents stay addressable: any later message to them auto-unarchives
 * the record. Archiving a still-working agent is refused (`AGENT_BUSY:`) -
 * stop it first or wait for it to settle. Unarchiving is never gated. A
 * repeat call in the already-requested state is idempotent and reports
 * `updated: false`, distinct from a missing record, which is a hard failure
 * (`RECORD_NOT_FOUND:`) rather than silently folded into `updated: false`.
 *
 * `--agent-id` takes the full id as-is - no prefix resolution, same caveat
 * as `agent stop`.
 */
export function buildAgentArchiveCommand(opts: {
  readonly epicId: string | null;
  readonly agentId: string;
  readonly unarchive: boolean;
}): CommandFn {
  return async () => {
    const archived = !opts.unarchive;
    const request = parseUserInput(setChatArchivedRequestSchema, {
      epicId: resolveEpicId(opts.epicId),
      chatId: opts.agentId,
      archived,
    });
    const result = await toAgentCliError(
      callHostRpc("epic.setChatArchived", request),
    ).catch((err: unknown) => {
      throw remapArchiveError(err, opts.agentId);
    });
    const { updated } = parseHostResponse(
      setChatArchivedResponseSchema,
      result,
    );
    const human = archiveHumanMessage(opts.agentId, archived, updated);
    return { data: { updated }, human, exitCode: 0 };
  };
}

function archiveHumanMessage(
  agentId: string,
  archived: boolean,
  updated: boolean,
): string {
  if (updated)
    return archived ? `${agentId} archived` : `${agentId} unarchived`;
  return archived
    ? `${agentId} already archived`
    : `${agentId} already unarchived`;
}

function remapArchiveError(err: unknown, agentId: string): unknown {
  if (!(err instanceof CliError) || err.code !== CLI_ERROR_CODES.UNEXPECTED) {
    return err;
  }
  if (err.message.startsWith(AGENT_BUSY_PREFIX)) {
    return cliError({
      code: CLI_ERROR_CODES.AGENT_ARCHIVE_BUSY,
      message:
        "traycer: agent is still working - stop it first with `traycer agent stop`, or wait for it to settle.",
      details: null,
      exitCode: 1,
    });
  }
  if (err.message.startsWith(RECORD_NOT_FOUND_PREFIX)) {
    return cliError({
      code: CLI_ERROR_CODES.AGENT_RECORD_NOT_FOUND,
      message: `traycer: no agent with id ${agentId} in this epic.`,
      details: null,
      exitCode: 1,
    });
  }
  return err;
}
