import { getAgentTranscriptResponseSchema } from "@traycer/protocol/host/agent/shared";
import {
  callHostRpc,
  parseHostResponse,
  toAgentCliError,
} from "../internal/host-rpc";
import { resolveEpicId } from "../internal/agent-context";
import type { CommandFn } from "../runner/runner";

/**
 * `traycer agent transcript` - print another agent's conversation as an
 * XML-tagged string (`agent.getTranscript`). Chat-interface agents return their
 * persisted message history, readable across hosts. Terminal-interface agents
 * return the coding agent's own durable session history - NOT PTY scrollback,
 * so it survives the terminal closing - but the read must run on the host that
 * owns that agent.
 */
export function buildAgentTranscriptCommand(opts: {
  readonly epicId: string | null;
  readonly agentId: string;
}): CommandFn {
  return async () => {
    const epicId = resolveEpicId(opts.epicId);
    const result = await toAgentCliError(
      callHostRpc("agent.getTranscript", {
        epicId,
        agentId: opts.agentId,
      }),
    );
    const { transcript } = parseHostResponse(
      getAgentTranscriptResponseSchema,
      result,
    );
    return { data: { transcript }, human: transcript, exitCode: 0 };
  };
}
