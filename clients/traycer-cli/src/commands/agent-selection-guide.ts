import {
  agentSelectionGuideRequestSchema,
  agentSelectionGuideResponseSchema,
} from "@traycer/protocol/host/agent/shared";
import {
  A2A_PERMISSION_MODE_INSTRUCTION,
  formatAgentSelectionGuideResponse,
} from "@traycer/protocol/agent/agent-selection-guide-format";
import {
  callHostRpc,
  parseHostResponse,
  parseUserInput,
  toAgentCliError,
} from "../internal/host-rpc";
import { resolveEpicId, resolveSenderAgentId } from "../internal/agent-context";
import type { CommandFn } from "../runner/runner";

export function buildAgentSelectionGuideCommand(opts: {
  readonly epicId: string | null;
  readonly senderAgentId: string | null;
}): CommandFn {
  return async () => {
    const epicId = resolveEpicId(opts.epicId);
    const senderAgentId = resolveSenderAgentId(opts.senderAgentId);
    const request = parseUserInput(agentSelectionGuideRequestSchema, {
      epicId,
      senderAgentId,
    });
    const result = await toAgentCliError(
      callHostRpc("agent.selectionGuide", request),
    );
    const response = parseHostResponse(
      agentSelectionGuideResponseSchema,
      result,
    );
    const human = formatAgentSelectionGuideResponse(response);
    return {
      data: {
        ...response,
        permissionModeInstruction: A2A_PERMISSION_MODE_INSTRUCTION,
      },
      human,
      exitCode: 0,
    };
  };
}
