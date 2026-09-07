import {
  stopAgentRequestSchema,
  stopAgentResponseSchema,
} from "@traycer/protocol/host/agent/shared";
import {
  callHostRpc,
  parseCanonicalHostResponse,
  parseUserInput,
  toAgentCliError,
} from "../internal/host-rpc";
import { resolveEpicId } from "../internal/agent-context";
import type { CommandFn } from "../runner/runner";

/** `traycer agent stop --agent-id <id> [--cascade]` - halt another agent's in-progress turn (`agent.stop`). Stopping is not terminal: a later message wakes the agent again through the normal path, so this halts work rather than deleting anything. */
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
    const { stoppedAgentIds } = parseCanonicalHostResponse(
      "agent.stop",
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
