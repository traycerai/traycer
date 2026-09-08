import { AMBIENT_PROFILE_ID_SENTINEL } from "@traycer/protocol/host/agent/shared";
import {
  providersSetEnabledRequestSchemaV21,
  providersSetEnabledResponseSchema,
} from "@traycer/protocol/host/provider-schemas";
import { providerIdSchema } from "@traycer/protocol/host/provider-ids";
import {
  callHostRpc,
  parseCanonicalHostResponse,
  parseUserInput,
  toAgentCliError,
} from "../internal/host-rpc";
import { cliError, CLI_ERROR_CODES } from "../runner/errors";
import type { CommandFn } from "../runner/runner";

/**
 * `traycer profile remove --provider <id> --profile <id>` - permanently
 * removes a managed profile (D23). Folds onto `providers.setEnabled`'s
 * `profileAction: { type: "remove" }` (D21) rather than a standalone method -
 * see `providerProfileActionSchema`'s doc comment for why a new top-level
 * method name can't ship here.
 *
 * The Default account is never a removable target (D05): rejected here,
 * client-side, before any RPC. The host separately refuses while the profile
 * has active sessions or is the provider's last enabled row - those messages
 * pass through `toAgentCliError` unchanged.
 */
export function buildProfileRemoveCommand(opts: {
  readonly provider: string;
  readonly profile: string;
}): CommandFn {
  return async () => {
    const providerId = parseUserInput(providerIdSchema, opts.provider);
    const profileId = opts.profile.trim();
    if (profileId === AMBIENT_PROFILE_ID_SENTINEL) {
      throw cliError({
        code: CLI_ERROR_CODES.INVALID_ARGUMENT,
        message: "traycer: the Default account cannot be removed.",
        details: null,
        exitCode: 1,
      });
    }
    if (profileId.length === 0) {
      throw cliError({
        code: CLI_ERROR_CODES.INVALID_ARGUMENT,
        message: "traycer: profile remove requires --profile <id>.",
        details: null,
        exitCode: 1,
      });
    }
    const request = parseUserInput(providersSetEnabledRequestSchemaV21, {
      providerId,
      // Ignored by the resolver whenever `profileAction` is non-null (it
      // only reads `enabled` on the plain enable/disable path) - `true`
      // matches the value the GUI's own remove-profile mutation sends
      // (`use-remove-provider-profile-mutation.ts`).
      enabled: true,
      profileAction: { type: "remove", profileId },
    });
    const result = await toAgentCliError(
      callHostRpc("providers.setEnabled", request, null),
    );
    const response = parseCanonicalHostResponse(
      "providers.setEnabled",
      providersSetEnabledResponseSchema,
      result,
    );
    return {
      data: response,
      human: `Removed profile ${profileId} for ${providerId}.`,
      exitCode: 0,
    };
  };
}
