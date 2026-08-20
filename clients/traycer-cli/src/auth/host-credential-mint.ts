import { hostname } from "node:os";
import { mintHostCredentialViaHttp } from "../../../shared/auth/devices-sessions-fetcher";
import type {
  HostCredentialMintFlow,
  HostCredentialMintOutcome,
} from "../../../shared/host-transport/host-credential-mint-flow";
import type { MintHostCredentialResponse } from "@traycer/protocol/auth/devices-sessions";

export interface CliHostCredentialMintOptions {
  readonly authnBaseUrl: string;
  /** The CLI's current bearer; read at mint time so a rotation is picked up. */
  readonly bearer: () => string | null;
  /** Diagnostic sink; the CLI routes these to stderr, never stdout. */
  readonly diag: (message: string) => void;
  /**
   * Cancels the mint HTTP request. A long-lived caller (monitor) passes null;
   * a deadline-bounded one (the host install probe) passes its controller's
   * signal so an abandoned mint cannot keep the drain-to-exit CLI alive.
   */
  readonly signal: AbortSignal | null;
  /**
   * Tail of the diagnostic printed when the mint returns nothing, stating
   * this surface's consequence - it differs: a connection-lease client loses
   * host access when its connection ends, while an install just leaves the
   * host unprovisioned for a later client to heal.
   */
  readonly unavailableNote: string;
  /**
   * Fired when authn answered the mint with 401/403 - the flow still returns
   * `unavailable` (the stream contract has no richer kind), but that result
   * is NOT like the others: the same stored bearer fails for every client,
   * so "a later client will provision it" may be false. The install probe
   * uses this to confirm via a rotation and report a dead sign-in honestly;
   * callers with no such follow-up pass null.
   */
  readonly onUnauthorized: (() => void) | null;
}

/**
 * Terminal implementation of the delegated host-credential mint.
 *
 * A single request on the CLI's ordinary bearer. This used to be an email-OTP
 * round trip gated on the terminal being interactive, which meant a host
 * provisioned from a background `traycer monitor` - the normal case, since it
 * runs as a background command whose stdout is the agent-facing stream - could
 * never acquire a credential at all and stayed on the connection lease forever.
 * The mint is no longer step-up gated (see the mint route's doc comment), so
 * there is nothing to prompt for and no headless case to special-case: every
 * surface provisions the same way.
 */
export function createCliHostCredentialMintFlow(
  options: CliHostCredentialMintOptions,
): HostCredentialMintFlow {
  return async (request): Promise<HostCredentialMintOutcome> => {
    const bearer = options.bearer();
    if (bearer === null || bearer.length === 0) {
      return { kind: "unavailable" };
    }

    const result = await mintHostCredentialViaHttp(
      options.authnBaseUrl,
      bearer,
      { hostId: request.hostId, hostLabel: hostLabel(), platform: null },
      options.signal,
    );
    if (result.kind === "ok") {
      return provisionedFrom(result.response);
    }
    if (result.kind === "unauthorized" && options.onUnauthorized !== null) {
      options.onUnauthorized();
    }
    // Includes the 409 supersede: another client already provisioned this host
    // and its credential is on the way, so there is nothing to hand over and
    // nothing to retry.
    options.diag(
      `could not provision host ${request.hostId} (${result.kind}); ${options.unavailableNote}`,
    );
    return { kind: "unavailable" };
  };
}

/**
 * Names the machine in Devices & Sessions. The CLI only ever reaches a host on
 * this same box (it dials the local pid metadata), so the local hostname really
 * is the host's machine - unlike the desktop, which may be talking to a remote
 * one and therefore leaves this to the directory.
 */
function hostLabel(): string | null {
  const name = hostname().trim();
  return name.length === 0 ? null : name;
}

/**
 * Carries the server's adoption tuple through verbatim. `familyId` and
 * `provisionedAt` are not derivable from the token, so anything that drops them
 * here leaves the host unable to order two credentials.
 */
function provisionedFrom(
  response: MintHostCredentialResponse,
): HostCredentialMintOutcome {
  return {
    kind: "provisioned",
    token: response.token,
    refreshToken: response.refreshToken,
    familyId: response.familyId,
    provisionedAt: response.provisionedAt,
    expiresIn: response.expiresIn,
  };
}
