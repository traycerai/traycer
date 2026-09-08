import { AMBIENT_PROFILE_ID_SENTINEL } from "@traycer/protocol/host/agent/shared";
import {
  providersListRequestSchema,
  providersListResponseSchema,
} from "@traycer/protocol/host/provider-schemas";
import {
  providerIdSchema,
  type ProviderId,
} from "@traycer/protocol/host/provider-ids";
import {
  providersTestProfileConnectionRequestSchema,
  providersTestProfileConnectionResponseSchema,
  type ProfileEndpointTestVerdict,
} from "@traycer/protocol/host/provider-profile-config-schemas";
import {
  callHostRpc,
  parseCanonicalHostResponse,
  parseUserInput,
  toAgentCliError,
} from "../internal/host-rpc";
import { cliError, CLI_ERROR_CODES } from "../runner/errors";
import type { CommandFn } from "../runner/runner";

/**
 * `traycer profile test --provider <id> --profile <id>` - re-runs D10's
 * connection test for a profile and reports its verdict. `--profile ambient`
 * targets the Default account, but only when it has a credential configured
 * (D05); an unconfigured Default account is rejected client-side rather than
 * spawning a test that has nothing to verify.
 */
export function buildProfileTestCommand(opts: {
  readonly provider: string;
  readonly profile: string;
}): CommandFn {
  return async () => {
    const providerId = parseUserInput(providerIdSchema, opts.provider);
    const rawProfile = opts.profile.trim();
    if (rawProfile.length === 0) {
      throw cliError({
        code: CLI_ERROR_CODES.INVALID_ARGUMENT,
        message: "traycer: profile test requires --profile <ambient|id>.",
        details: null,
        exitCode: 1,
      });
    }
    const isDefaultAccount = rawProfile === AMBIENT_PROFILE_ID_SENTINEL;
    if (isDefaultAccount) {
      await assertDefaultAccountHasEndpointConfigured(providerId);
    }
    const profileId = isDefaultAccount ? null : rawProfile;
    const request = parseUserInput(
      providersTestProfileConnectionRequestSchema,
      { providerId, profileId },
    );
    const result = await toAgentCliError(
      callHostRpc("providers.testProfileConnection", request, null),
    );
    const response = parseCanonicalHostResponse(
      "providers.testProfileConnection",
      providersTestProfileConnectionResponseSchema,
      result,
    );
    const target = isDefaultAccount ? "the Default account" : rawProfile;
    return {
      data: response,
      human: `Test connection for ${target} (${providerId}): ${formatVerdict(response.verdict)}`,
      exitCode: response.verdict.ok ? 0 : 1,
    };
  };
}

async function assertDefaultAccountHasEndpointConfigured(
  providerId: ProviderId,
): Promise<void> {
  const listResult = await toAgentCliError(
    callHostRpc(
      "providers.list",
      parseUserInput(providersListRequestSchema, { native: null }),
      null,
    ),
  );
  const listResponse = parseCanonicalHostResponse(
    "providers.list",
    providersListResponseSchema,
    listResult,
  );
  const providerRow = listResponse.providers.find(
    (row) => row.providerId === providerId,
  );
  const ambientProfile =
    providerRow?.profiles.find((profile) => profile.kind === "ambient") ?? null;
  const configured = ambientProfile?.endpoint?.credentialConfigured === true;
  if (!configured) {
    throw cliError({
      code: CLI_ERROR_CODES.INVALID_ARGUMENT,
      message:
        "traycer: the Default account has no endpoint credential configured to test.",
      details: null,
      exitCode: 1,
    });
  }
}

function formatVerdict(verdict: ProfileEndpointTestVerdict): string {
  const timestamp = new Date(verdict.at).toISOString();
  if (verdict.ok) return `ok@${timestamp}`;
  return verdict.reason === null
    ? `failed@${timestamp}`
    : `failed@${timestamp}: ${verdict.reason}`;
}
