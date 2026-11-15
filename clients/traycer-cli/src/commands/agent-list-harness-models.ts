import { formatListHarnessModelsResponse } from "@traycer/protocol/agent/agent-harness-models";
import {
  listHarnessModelsRequestSchema,
  listHarnessModelsResponseSchema,
  type ListHarnessModelsResponse,
} from "@traycer/protocol/host/agent/shared";
import { AGENT_LIST_HARNESS_MODELS_PROFILE_REQUIRED_HOST_VERSION } from "@traycer/protocol/host/registry";
import {
  callAgentHostRpc,
  callAgentHostRpcWithDispatch,
  PLAIN_DISPATCH,
  parseCanonicalHostResponse,
  parseUserInput,
  toAgentCliError,
} from "../internal/host-rpc";
import { readEpicId, readTuiAgentId } from "../internal/agent-context";
import type { CommandFn } from "../runner/runner";

export function buildAgentListHarnessModelsCommand(opts: {
  readonly epicId: string | null;
  readonly senderAgentId: string | null;
  readonly harnessId: string;
  readonly profileId: string | null;
}): CommandFn {
  return async () => {
    const epicId = readEpicId(opts.epicId);
    const senderAgentId = readTuiAgentId(opts.senderAgentId);
    const response = await listSingleHarnessModels(
      opts.harnessId,
      epicId,
      senderAgentId,
      opts.profileId === "ambient" ? null : opts.profileId,
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
  profileId: string | null,
): Promise<ListHarnessModelsResponse> {
  const request = parseUserInput(listHarnessModelsRequestSchema, {
    epicId,
    senderAgentId,
    harnessId,
    profileId: profileId ?? undefined,
  });
  const result = await toAgentCliError(
    request.profileId === undefined
      ? callAgentHostRpc("agent.listHarnessModels", request)
      : callAgentHostRpcWithDispatch("agent.listHarnessModels", request, {
          ...PLAIN_DISPATCH,
          requiredHostMethodVersion:
            AGENT_LIST_HARNESS_MODELS_PROFILE_REQUIRED_HOST_VERSION,
        }),
  );
  return parseCanonicalHostResponse(
    "agent.listHarnessModels",
    listHarnessModelsResponseSchema,
    result,
  );
}
