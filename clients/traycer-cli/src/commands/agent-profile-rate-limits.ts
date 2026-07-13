import { formatAgentProviderProfileRateLimitsResponse } from "@traycer/protocol/agent/agent-profile-format";
import {
  agentGetProviderProfileRateLimitsRequestSchema,
  agentGetProviderProfileRateLimitsResponseSchema,
} from "@traycer/protocol/host/agent/profiles";
import {
  callHostRpc,
  parseHostResponse,
  parseUserInput,
  toAgentCliError,
} from "../internal/host-rpc";
import { resolveEpicId, resolveSenderAgentId } from "../internal/agent-context";
import { parseConcreteProfileSelection } from "../internal/profile-selection";
import type { CommandFn } from "../runner/runner";

/**
 * `traycer agent profile-rate-limits <harness> --profile <ambient|id>` - a
 * fresh, detailed provider read for ONE concrete profile, distinct from the
 * cached per-row status `list-profiles` shows. `--profile` is required: there
 * is no last-used fallback here, because a rate-limit read is only meaningful
 * against a profile the caller has already picked.
 *
 * A provider-side failure comes back as the normalized `available: false` arm
 * (a successful RPC reporting an unavailable read), so the command still exits
 * 0 and the formatter prints the reason instead of inventing a reading.
 */
export function buildAgentProfileRateLimitsCommand(opts: {
  readonly epicId: string | null;
  readonly senderAgentId: string | null;
  readonly harnessId: string;
  readonly profile: string;
}): CommandFn {
  return async () => {
    const profileSelection = parseConcreteProfileSelection(opts.profile);
    const request = parseUserInput(
      agentGetProviderProfileRateLimitsRequestSchema,
      {
        epicId: resolveEpicId(opts.epicId),
        senderAgentId: resolveSenderAgentId(opts.senderAgentId),
        harnessId: opts.harnessId,
        profileSelection,
      },
    );
    const result = await toAgentCliError(
      callHostRpc("agent.getProviderProfileRateLimits", request),
    );
    const response = parseHostResponse(
      agentGetProviderProfileRateLimitsResponseSchema,
      result,
    );
    return {
      data: response,
      human: formatAgentProviderProfileRateLimitsResponse(
        profileSelection,
        response,
      ),
      exitCode: 0,
    };
  };
}
