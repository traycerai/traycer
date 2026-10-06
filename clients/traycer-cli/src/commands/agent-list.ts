import {
  listAgentsResponseSchema,
  type ListAgentsResponse,
} from "@traycer/protocol/host/agent/shared";
import { formatAgentListPage } from "@traycer/protocol/agent/agent-list-format";
import {
  callHostRpc,
  parseCanonicalHostResponse,
  toAgentCliError,
} from "../internal/host-rpc";
import { resolveEpicId, resolveSenderAgentId } from "../internal/agent-context";
import { CLI_ERROR_CODES, cliError } from "../runner/errors";
import type { CommandFn } from "../runner/runner";

/**
 * `traycer agent list` - enumerate every agent the epic's Y.Doc sees
 * (`agent.list`). Cross-host agents are included as read-only rows;
 * `local=false` marks them. Pass `--json` (global runner flag) for the
 * structured payload, whose rows carry `archived` since `agent.list@9.2`.
 *
 * `--live` and `--compact` are applied HERE, to the response the host already
 * sent: the request does not change, so both work against any host that can
 * answer `agent.list` at all. There is no paging flag - `--json` is the
 * compact form a script should read, and a person's terminal scrolls.
 */
export function buildAgentListCommand(opts: {
  readonly epicId: string | null;
  readonly senderAgentId: string | null;
  readonly all: boolean;
  /** Leave archived agents out of both the text and the JSON payload. */
  readonly live: boolean;
  /** One short line per agent: no folders, model, session or owner host. */
  readonly compact: boolean;
}): CommandFn {
  return async () => {
    const epicId = resolveEpicId(opts.epicId);
    const senderAgentId = resolveSenderAgentId(opts.senderAgentId);
    const result = await toAgentCliError(
      callHostRpc("agent.list", {
        epicId,
        senderAgentId,
        scope: opts.all ? ("all" as const) : ("user" as const),
      }),
    );
    const response = parseCanonicalHostResponse(
      "agent.list",
      listAgentsResponseSchema,
      result,
    );
    const listed = opts.live ? liveAgentsOnly(response) : response;
    return {
      data: listed,
      human: formatAgentListPage(listed, {
        detail: opts.compact ? "compact" : "full",
        page: null,
      }),
      exitCode: 0,
    };
  };
}

/**
 * The listing without its archived rows.
 *
 * REFUSES when any row's `archived` is `null`, which is what a Host older
 * than `agent.list@9.2` answers for every row: it was never asked. Printing
 * every row under a flag that promises live ones only would be a silent wrong
 * answer for exactly the script that passes `--live`, so the command fails
 * and says what to do instead.
 */
function liveAgentsOnly(response: ListAgentsResponse): ListAgentsResponse {
  if (response.agents.some((agent) => agent.archived === null)) {
    throw cliError({
      code: CLI_ERROR_CODES.HOST_UNSUPPORTED,
      message:
        "traycer: this Host does not report archive status yet, so --live cannot tell archived agents from live ones. Update the Host, or drop --live.",
      details: null,
      exitCode: 1,
    });
  }
  return {
    ...response,
    agents: response.agents.filter((agent) => agent.archived !== true),
  };
}
