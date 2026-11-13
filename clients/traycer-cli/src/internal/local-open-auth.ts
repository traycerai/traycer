import type { FatalErrorDetails } from "@traycer/protocol/framework/ws-protocol";
import {
  TEAM_MEMBERSHIP_REQUIRED,
  TEAM_MEMBERSHIP_REQUIRED_MESSAGE,
  TEAM_MEMBERSHIP_UNAVAILABLE,
} from "../../../shared/host-transport/local-open-auth";
import { cliError, CLI_ERROR_CODES, type CliError } from "../runner/errors";
import { createLocalOpenAuth } from "../../../shared/host-transport/create-local-open-auth";
import type { LocalOpenAuth } from "../../../shared/host-transport/local-open-auth";
import { createWhatwgStreamWebSocketFactory } from "../../../shared/host-transport/whatwg-stream-ws-factory";
import { createCliHostCredentialMintFlow } from "../auth/host-credential-mint";
import { CLI_CLIENT_IDENTITY } from "../cli-version";

/** Local transport policy shared by every CLI unary and stream composition. */
export function createCliLocalOpenAuth(authnBaseUrl: string): LocalOpenAuth {
  return createLocalOpenAuth({
    authnBaseUrl: authnBaseUrl,
    cloudAuthorized: () => true,
    webSocketFactory: createWhatwgStreamWebSocketFactory(),
    clientIdentity: CLI_CLIENT_IDENTITY,
    clock: null,
    mintMemberCredential: async (hostId, bearer, signal) => {
      const mint = createCliHostCredentialMintFlow({
        authnBaseUrl: authnBaseUrl,
        bearer: () => bearer.getBearerToken(),
        signal,
        diag: () => undefined,
        unavailableNote: "team membership could not be checked.",
        onUnauthorized: null,
      });
      const outcome = await mint({ hostId, reason: "missing" });
      if (outcome.kind !== "provisioned") return null;
      return {
        token: outcome.token,
        refreshToken: outcome.refreshToken,
        familyId: outcome.familyId,
        provisionedAt: outcome.provisionedAt,
      };
    },
    onMemberCredentialAdopted: () => undefined,
  });
}

/** Typed admission failures never quote server text or account details. */
export function localTeamAdmissionCliError(
  details: FatalErrorDetails,
): CliError | null {
  if (details.code === TEAM_MEMBERSHIP_REQUIRED) {
    return cliError({
      code: CLI_ERROR_CODES.TEAM_MEMBERSHIP_REQUIRED,
      message: `traycer: ${TEAM_MEMBERSHIP_REQUIRED_MESSAGE} Run \`traycer login\` to switch accounts.`,
      details: null,
      exitCode: 1,
    });
  }
  if (details.code === TEAM_MEMBERSHIP_UNAVAILABLE) {
    return cliError({
      code: CLI_ERROR_CODES.TEAM_MEMBERSHIP_UNAVAILABLE,
      message:
        "traycer: could not reach the cloud to check team membership. Try the command again.",
      details: null,
      exitCode: 1,
    });
  }
  return null;
}
