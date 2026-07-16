import { formatAgentProviderProfilesResponse } from "@traycer/protocol/agent/agent-profile-format";
import {
  agentListProviderProfilesRequestSchema,
  agentListProviderProfilesResponseSchema,
} from "@traycer/protocol/host/agent/profiles";
import {
  callHostRpc,
  parseHostResponse,
  parseUserInput,
  toAgentCliError,
} from "../internal/host-rpc";
import { resolveEpicId, resolveSenderAgentId } from "../internal/agent-context";
import type { CommandFn } from "../runner/runner";

/**
 * `traycer agent list-profiles <harness>` - the provider profiles available
 * for a harness (the ambient CLI login plus any managed subscriptions), each
 * with its cached rate-limit status and a `--profile` value that reselects it
 * in a later `create` / `profile-rate-limits` / `configure` call.
 *
 * `agent.listProviderProfiles` is an optional host method: against a host that
 * doesn't advertise it, the transport raises `E_HOST_UNSUPPORTED` and the
 * shared agent error boundary reports it as `E_HOST_UNSUPPORTED` with
 * host-upgrade guidance.
 */
export function buildAgentListProfilesCommand(opts: {
  readonly epicId: string | null;
  readonly senderAgentId: string | null;
  readonly harnessId: string;
}): CommandFn {
  return async () => {
    const request = parseUserInput(agentListProviderProfilesRequestSchema, {
      epicId: resolveEpicId(opts.epicId),
      senderAgentId: resolveSenderAgentId(opts.senderAgentId),
      harnessId: opts.harnessId,
    });
    const result = await toAgentCliError(
      callHostRpc("agent.listProviderProfiles", request),
    );
    const response = parseHostResponse(
      agentListProviderProfilesResponseSchema,
      result,
    );
    return {
      data: response,
      human: formatAgentProviderProfilesResponse(response),
      exitCode: 0,
    };
  };
}
