import { listAgentsResponseSchema } from "@traycer/protocol/host/agent/shared";
import { formatAgentListResponse } from "@traycer/protocol/agent/agent-list-format";
import {
  callHostRpc,
  parseHostResponse,
  toAgentCliError,
} from "../internal/host-rpc";
import { resolveEpicId, resolveSenderAgentId } from "../internal/agent-context";
import type { CommandFn } from "../runner/runner";

/**
 * `traycer agent list` - enumerate every agent the epic's Y.Doc sees
 * (`agent.list`). Cross-host agents are included as read-only rows;
 * `local=false` marks them. Pass `--json` (global runner flag) for the
 * structured payload.
 */
export function buildAgentListCommand(opts: {
  readonly epicId: string | null;
  readonly senderAgentId: string | null;
  readonly all: boolean;
}): CommandFn {
  return async () => {
    const epicId = resolveEpicId(opts.epicId);
    const senderAgentId = resolveSenderAgentId(opts.senderAgentId);
    const result = await toAgentCliError(
      callHostRpc("agent.list", {
        epicId,
        senderAgentId,
        scope: opts.all ? "all" : "user",
      }),
    );
    const response = parseHostResponse(listAgentsResponseSchema, result);
    return {
      data: response,
      human: formatAgentListResponse(response),
      exitCode: 0,
    };
  };
}
