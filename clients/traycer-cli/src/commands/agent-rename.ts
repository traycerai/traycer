import {
  listAgentsResponseSchema,
  type ListAgentsResponse,
} from "@traycer/protocol/host/agent/shared";
import {
  renameChatRequestSchema,
  renameChatResponseSchema,
  renameTuiAgentRequestSchema,
  renameTuiAgentResponseSchema,
} from "@traycer/protocol/host/epic/unary-schemas";
import { isLegacyHost } from "@traycer/protocol/persistence/epic/chat";
import {
  callHostRpc,
  parseCanonicalHostResponse,
  parseUserInput,
  toAgentCliError,
} from "../internal/host-rpc";
import { resolveEpicId, resolveSenderAgentId } from "../internal/agent-context";
import { cliError, CliError, CLI_ERROR_CODES } from "../runner/errors";
import type { CommandFn } from "../runner/runner";

// The host raises this on the generic `RPC_ERROR` message rather than a typed
// wire code when a terminal agent's record belongs to another host - see
// `assertTuiAgentLocal` in `tui-agent-locality.ts`.
const TARGET_NOT_LOCAL_PREFIX = "TARGET_NOT_LOCAL:";

/**
 * `traycer agent rename <id> <name>` - set the display name of a GUI chat or
 * terminal agent. The name is marked user-authored, so automatic title
 * generation never overwrites it.
 *
 * The epic's `agent.list` says which kind of record the id names and whether
 * this host runs it: a GUI chat is renamed through `epic.renameChat`, a
 * terminal agent through `epic.renameTuiAgent`. An agent another host runs is
 * refused before anything is written (`E_AGENT_NOT_LOCAL`), the same refusal
 * the `traycer_rename_agent` tool gives; rename it from its own host.
 *
 * `<id>` takes the full id as-is - no prefix resolution, same caveat as
 * `agent stop` and `agent archive`. The name is trimmed and a blank name is
 * refused.
 */
export function buildAgentRenameCommand(opts: {
  readonly epicId: string | null;
  readonly senderAgentId: string | null;
  readonly agentId: string;
  readonly name: string;
}): CommandFn {
  return async () => {
    const name = opts.name.trim();
    if (name.length === 0) {
      throw cliError({
        code: CLI_ERROR_CODES.INVALID_ARGUMENT,
        message:
          "traycer: a blank name is refused - pass the new display name.",
        details: null,
        exitCode: 1,
      });
    }
    const epicId = resolveEpicId(opts.epicId);
    const senderAgentId = resolveSenderAgentId(opts.senderAgentId);

    const listed = parseCanonicalHostResponse(
      "agent.list",
      listAgentsResponseSchema,
      await toAgentCliError(
        callHostRpc("agent.list", {
          epicId,
          senderAgentId,
          scope: "user" as const,
        }),
      ),
    );
    const target = findAgent(listed, opts.agentId);
    if (target === null) {
      throw cliError({
        code: CLI_ERROR_CODES.AGENT_RECORD_NOT_FOUND,
        message: `traycer: no agent with id ${opts.agentId} in this epic.`,
        details: null,
        exitCode: 1,
      });
    }
    // A chat migrated from v1.0.0 names the `legacy` sentinel as its origin and
    // reads `isLocal: false`; the host's rename paths admit it, so only a row
    // bound to a real other host is refused here.
    if (!target.isLocal && !isLegacyHost(target.hostId)) {
      throw notLocalError(opts.agentId);
    }

    const updated = await renameRecord({
      epicId,
      agentId: opts.agentId,
      surface: target.surface,
      name,
    }).catch((err: unknown) => {
      throw remapRenameError(err, opts.agentId);
    });
    const human = updated
      ? `${opts.agentId} renamed to "${name}"`
      : `${opts.agentId}: no change (already named "${name}")`;
    return {
      data: { agentId: opts.agentId, name, updated },
      human,
      exitCode: 0,
    };
  };
}

function findAgent(listed: ListAgentsResponse, agentId: string) {
  return listed.agents.find((agent) => agent.id === agentId) ?? null;
}

async function renameRecord(opts: {
  readonly epicId: string;
  readonly agentId: string;
  readonly surface: "gui" | "tui";
  readonly name: string;
}): Promise<boolean> {
  if (opts.surface === "gui") {
    const request = parseUserInput(renameChatRequestSchema, {
      epicId: opts.epicId,
      chatId: opts.agentId,
      title: opts.name,
    });
    const result = await toAgentCliError(
      callHostRpc("epic.renameChat", request),
    );
    return parseCanonicalHostResponse(
      "epic.renameChat",
      renameChatResponseSchema,
      result,
    ).updated;
  }
  const request = parseUserInput(renameTuiAgentRequestSchema, {
    epicId: opts.epicId,
    tuiAgentId: opts.agentId,
    title: opts.name,
  });
  const result = await toAgentCliError(
    callHostRpc("epic.renameTuiAgent", request),
  );
  return parseCanonicalHostResponse(
    "epic.renameTuiAgent",
    renameTuiAgentResponseSchema,
    result,
  ).updated;
}

function notLocalError(agentId: string): CliError {
  return cliError({
    code: CLI_ERROR_CODES.AGENT_NOT_LOCAL,
    message: `traycer: ${agentId} runs on another host - rename it from that host instead.`,
    details: null,
    exitCode: 1,
  });
}

function remapRenameError(err: unknown, agentId: string): unknown {
  if (!(err instanceof CliError) || err.code !== CLI_ERROR_CODES.UNEXPECTED) {
    return err;
  }
  if (err.message.startsWith(TARGET_NOT_LOCAL_PREFIX)) {
    return notLocalError(agentId);
  }
  return err;
}
