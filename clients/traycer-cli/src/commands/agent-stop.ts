import {
  stopAgentRequestSchema,
  stopAgentResponseSchema,
} from "@traycer/protocol/host/agent/shared";
import {
  callHostRpc,
  parseHostResponse,
  parseUserInput,
  toAgentCliError,
} from "../internal/host-rpc";
import { resolveEpicId } from "../internal/agent-context";
import type { CommandFn } from "../runner/runner";

/**
 * `traycer agent stop --agent-id <id> [--cascade]` - halt another agent's
 * in-progress turn (`agent.stop`).
 *
 * Stopping is not terminal: a later message wakes the agent again through
 * the normal path, so this halts work rather than deleting anything.
 * `--cascade` also reaches the active descendants the agent delegated to.
 *
 * `--agent-id` takes the full id as-is - unlike the A2A `traycer_stop_agent`
 * tool, this RPC does no id-prefix resolution, so a truncated id fails
 * rather than resolving.
 *
 * Authorization is the epic-editor role (`defineEditorResolver`), not the
 * A2A tool's sender-lineage/same-host/can't-stop-self guards: this command
 * is for the human/script audience of #1061, where those guards don't apply.
 */
export function buildAgentStopCommand(opts: {
  readonly epicId: string | null;
  readonly agentId: string;
  readonly cascade: boolean;
}): CommandFn {
  return async () => {
    const request = parseUserInput(stopAgentRequestSchema, {
      epicId: resolveEpicId(opts.epicId),
      agentId: opts.agentId,
      cascade: opts.cascade,
    });
    const result = await toAgentCliError(callHostRpc("agent.stop", request));
    const { stoppedAgentIds } = parseHostResponse(
      stopAgentResponseSchema,
      result,
    );
    const human =
      stoppedAgentIds.length === 0
        ? "no agents stopped"
        : stoppedAgentIds.join("\n");
    return { data: { stoppedAgentIds }, human, exitCode: 0 };
  };
}
