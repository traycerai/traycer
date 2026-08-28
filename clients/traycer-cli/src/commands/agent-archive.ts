import {
  setChatArchivedRequestSchema,
  setChatArchivedResponseSchema,
} from "@traycer/protocol/host/epic/unary-schemas";
import {
  callHostRpc,
  parseCanonicalHostResponse,
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
const TARGET_NOT_LOCAL_PREFIX = "TARGET_NOT_LOCAL:";

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
    const { updated } = parseCanonicalHostResponse(
      "epic.setChatArchived",
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
  // Deliberately noncommittal about WHY nothing changed. This host throws
  // `RECORD_NOT_FOUND:` for an absent id, but `epic.setChatArchived@1.0`'s
  // response contract also permits `updated: false` for a record that did not
  // match, so a compatible host may answer `false` where this one throws.
  // Asserting "already archived" would then report success for a stale or
  // mistyped id. Distinguishing the two needs a versioned response, not a
  // guess at this layer.
  const state = archived ? "archived" : "unarchived";
  return `${agentId}: no change (already ${state}, or no such record)`;
}

function remapArchiveError(err: unknown, agentId: string): unknown {
  if (!(err instanceof CliError) || err.code !== CLI_ERROR_CODES.UNEXPECTED) {
    return err;
  }
  if (err.message.startsWith(AGENT_BUSY_PREFIX)) {
    return cliError({
      code: CLI_ERROR_CODES.AGENT_ARCHIVE_BUSY,
      // Carry the host's OWN busy text through rather than substituting a
      // single "stop it first" line. `archiveBlockedMessage` has two arms and
      // they prescribe DIFFERENT remedies: a running turn is cleared by
      // stopping, whereas detached subagents/workflows/scheduled wakes survive
      // a stop and must be waited out or stopped individually. Collapsing both
      // into "stop it first" walks the second case into a retry loop, and any
      // arm the host adds later would inherit the same wrong advice.
      message: `traycer: ${stripBusyPrefix(err.message)}`,
      details: null,
      exitCode: 1,
    });
  }
  // Cross-host archive refusal. `E_AGENT_NOT_LOCAL` already exists as the CLI
  // surface for "this agent runs elsewhere" (see `mapHostRpcError`), and the
  // GUI gives this same refusal its own copy - without the remap a script sees
  // only `E_UNEXPECTED` plus raw internal text for an actionable condition.
  if (err.message.startsWith(TARGET_NOT_LOCAL_PREFIX)) {
    return cliError({
      code: CLI_ERROR_CODES.AGENT_NOT_LOCAL,
      message: `traycer: ${agentId} runs on another host - archive it from that host instead.`,
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

/**
 * Drops the wire-level `AGENT_BUSY:` reason prefix, leaving the host's
 * human-readable explanation (which already names the applicable remedy).
 */
function stripBusyPrefix(message: string): string {
  return message.slice(AGENT_BUSY_PREFIX.length).trim();
}
