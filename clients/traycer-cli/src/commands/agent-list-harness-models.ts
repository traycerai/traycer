import { formatListHarnessModelsResponse } from "@traycer/protocol/agent/agent-harness-models";
import {
  listHarnessModelsRequestSchema,
  listHarnessModelsResponseSchema,
} from "@traycer/protocol/host/agent/shared";
import {
  callHostRpc,
  parseHostResponse,
  parseUserInput,
  toAgentCliError,
} from "../internal/host-rpc";
import { resolveEpicId, resolveSenderAgentId } from "../internal/agent-context";
import type { CommandFn } from "../runner/runner";

export function buildAgentListHarnessModelsCommand(opts: {
  readonly epicId: string | null;
  readonly senderAgentId: string | null;
  readonly harnessId: string;
}): CommandFn {
  return async () => {
    const epicId = resolveEpicId(opts.epicId);
    const senderAgentId = resolveSenderAgentId(opts.senderAgentId);
    const request = parseUserInput(listHarnessModelsRequestSchema, {
      epicId,
      senderAgentId,
      harnessId: opts.harnessId,
    });
    const result = await toAgentCliError(
      callHostRpc("agent.listHarnessModels", request),
    );
    const response = parseHostResponse(listHarnessModelsResponseSchema, result);
    return {
      data: response,
      human: formatListHarnessModelsResponse(response),
      exitCode: 0,
    };
  };
}
