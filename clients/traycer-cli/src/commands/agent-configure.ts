import { formatAgentConfigureResponse } from "@traycer/protocol/agent/agent-profile-format";
import {
  agentConfigureRequestSchemaV20,
  agentConfigureResponseSchema,
} from "@traycer/protocol/host/agent/profiles";
import {
  callHostRpc,
  parseCanonicalHostResponse,
  parseUserInput,
  toAgentCliError,
} from "../internal/host-rpc";
import { resolveEpicId, resolveSenderAgentId } from "../internal/agent-context";
import { parseConcreteProfileSelection } from "../internal/profile-selection";
import type { CommandFn } from "../runner/runner";

/** `traycer agent configure --agent-id … --harness … --model … --profile …` - atomically switch the harness, profile, model, and permission mode an existing local GUI agent uses for FUTURE turns (an active turn and already-queued messages keep the settings they were stamped with). The request carries the complete future run tuple, not a patch, so every field the RPC requires is supplied on every call: `--reasoning-effort`, `--fast`, and `--permission-mode` are part of that tuple. */
export function buildAgentConfigureCommand(opts: {
  readonly epicId: string | null;
  readonly senderAgentId: string | null;
  readonly agentId: string;
  readonly harness: string;
  readonly model: string;
  readonly profile: string;
  readonly reasoningEffort: string | null;
  readonly fast: boolean;
  readonly permissionMode: string | null;
}): CommandFn {
  return async () => {
    const request = parseUserInput(agentConfigureRequestSchemaV20, {
      epicId: resolveEpicId(opts.epicId),
      senderAgentId: resolveSenderAgentId(opts.senderAgentId),
      agentId: opts.agentId,
      harnessId: opts.harness,
      model: opts.model,
      profileSelection: parseConcreteProfileSelection(opts.profile),
      reasoningEffort: opts.reasoningEffort,
      fastMode: opts.fast,
      permissionMode: opts.permissionMode ?? "full_access",
    });
    const result = await toAgentCliError(
      callHostRpc("agent.configure", request),
    );
    const response = parseCanonicalHostResponse(
      "agent.configure",
      agentConfigureResponseSchema,
      result,
    );
    return {
      data: response,
      human: formatAgentConfigureResponse(opts.agentId, response),
      exitCode: 0,
    };
  };
}
