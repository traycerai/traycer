import { formatAgentProviderProfileRateLimitsResponse } from "@traycer/protocol/agent/agent-profile-format";
import {
  agentGetProviderProfileRateLimitsRequestSchema,
  agentGetProviderProfileRateLimitsResponseSchemaV6,
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
    // The explicit v6.0 schema, not the base `...ResponseSchema` name this
    // used to read. That name is a structurally identical but DISTINCT object
    // that is canonical for nothing, so naming the version pins the contract
    // and lets `parseCanonicalHostResponse` prove it.
    //
    // This was `...V5` until `cli-v1.3.0` shipped the v5.0 line and froze it
    // (traycerai/traycer#1808). The CLI negotiates the HEAD contract at
    // handshake, so it has to parse against the head: pinned at the frozen
    // v5.0 it would have strict-decoded a v6.0 response and silently dropped
    // `antigravity` from a rate-limit read. `assertCanonicalResponseSchema` is
    // what turned that into a red CI job instead of a wrong answer. Move this
    // to `...V7` the same day a tag ships v6.0.
    const response = parseCanonicalHostResponse(
      "agent.getProviderProfileRateLimits",
      agentGetProviderProfileRateLimitsResponseSchemaV6,
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
