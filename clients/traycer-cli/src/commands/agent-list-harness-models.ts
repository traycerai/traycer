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
import { readEpicId, readTuiAgentId } from "../internal/agent-context";
import type { CommandFn } from "../runner/runner";

export function buildAgentListHarnessModelsCommand(opts: {
  readonly epicId: string | null;
  readonly senderAgentId: string | null;
  readonly harnessId: string;
}): CommandFn {
  return async () => {
    const epicId = readEpicId(opts.epicId);
    const senderAgentId = readTuiAgentId(opts.senderAgentId);
    const response = await listSingleHarnessModels(
      opts.harnessId,
      epicId,
      senderAgentId,
    );
    return {
      data: response,
      human: formatListHarnessModelsResponse(response),
      exitCode: 0,
    };
  };
}

async function listSingleHarnessModels(
  harnessId: string,
  epicId: string | null,
  senderAgentId: string | null,
) {
  const request = parseUserInput(listHarnessModelsRequestSchema, {
    epicId,
    senderAgentId,
    harnessId,
  });
  const result = await toAgentCliError(
    callHostRpc("agent.listHarnessModels", request),
  );
  return parseHostResponse(listHarnessModelsResponseSchema, result);
}
