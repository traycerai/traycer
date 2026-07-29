import { useEffect, useRef, type ReactNode } from "react";
import type {
  HostCredentialMintOutcome,
  HostCredentialMintRequest,
} from "@traycer-clients/shared/host-transport/host-credential-mint-flow";
import type { MintHostCredentialFetchResult } from "@traycer-clients/shared/auth/devices-sessions-fetcher";
import { useHostBinding, useHostDirectory } from "@/lib/host";
import {
  resetHostCredentialProvisioning,
  setHostCredentialMintRunner,
} from "@/lib/auth/host-credential-provisioning";
import { useAuthStore } from "@/stores/auth/auth-store";

/**
 * Owns delegated host-credential provisioning: when a connected host reports it
 * has no credential of its own, this mints one against authn-v3 and hands it
 * back to the stream transport that asked.
 *
 * Provisioning is **silent** - no dialog, no OTP. A delegated host credential is
 * a refresh family like any other, bounded by the owner seeing its row in
 * Devices & Sessions and revoking it there, exactly as for an interactive
 * session. (Earlier revisions gated this on step-up and carried a prompt, a
 * per-window memo and a cross-window arbiter to keep the dialogs from stacking;
 * all of it went with the gate.)
 *
 * Mounted once, app-wide, inside the authenticated runtime. It registers a
 * runner with `lib/auth/host-credential-provisioning`, which is the module every
 * `WsStreamClient` reaches through - so however many transports notice the same
 * host, exactly one mint is in flight for it.
 *
 * A failure is not an error anyone needs to see: the host keeps working on the
 * connection's credential lease, which is what every host did before this
 * existed. It simply stops working when the app disconnects.
 */
export function HostCredentialProvisionProvider(props: {
  readonly children: ReactNode;
}): ReactNode {
  const binding = useHostBinding();
  const directory = useHostDirectory();
  const userId = useAuthStore((s) => s.contextMetadata?.userId ?? null);
  /**
   * Read at mint time rather than closed over, so a runner registered under one
   * identity cannot mint under another.
   */
  const identityRef = useRef(userId);

  useEffect(() => {
    const run = async (
      request: HostCredentialMintRequest,
    ): Promise<HostCredentialMintOutcome> => {
      const auth = binding?.auth ?? null;
      if (auth === null) {
        return { kind: "unavailable" };
      }
      // Best-effort: the directory names the machine so the Devices & Sessions
      // row is identifiable. A host we cannot name still gets a credential.
      const hostLabel = directory.findById(request.hostId)?.label ?? null;
      const identityAtStart = identityRef.current;
      try {
        const result = await auth.mintHostCredential({
          hostId: request.hostId,
          hostLabel,
          // The server falls back to the caller's user-agent platform. Correct
          // while every host is local; a remote host will need to report its own.
          platform: null,
        });
        if (identityRef.current !== identityAtStart) {
          // The signed-in user changed while the mint was in flight. This
          // credential was authorized by the departing user's bearer, and it has
          // ALREADY superseded whatever the host was using. Dropping it here
          // keeps it from reaching a transport now serving someone else; the
          // host would reject it anyway, since it asserts the token's `id`
          // matches its own owner-gated identity.
          return { kind: "unavailable" };
        }
        return toMintOutcome(result);
      } catch {
        return { kind: "unavailable" };
      }
    };
    setHostCredentialMintRunner(run);
    return () => {
      setHostCredentialMintRunner(null);
    };
    // Re-registered whenever the binding or directory identity changes: the
    // runner must never close over a stale auth service, and swapping the
    // module's runner is a plain assignment that cannot disturb a mint already
    // in flight (the provisioning module holds that promise, not this effect).
  }, [binding, directory]);

  // Scoped to the signed-in IDENTITY, not to the host binding: the binding is
  // installed once at runtime startup and lives until the provider unmounts, so
  // watching it would mean a normal sign-out never abandoned an in-flight mint
  // and the next user on this machine could be handed the previous user's
  // credential.
  useEffect(() => {
    identityRef.current = userId;
    resetHostCredentialProvisioning();
  }, [userId]);

  return <>{props.children}</>;
}

function toMintOutcome(
  result: MintHostCredentialFetchResult,
): HostCredentialMintOutcome {
  if (result.kind === "ok") {
    return {
      kind: "provisioned",
      token: result.response.token,
      refreshToken: result.response.refreshToken,
      // Relayed verbatim: neither is derivable from the token, and the host
      // needs both to order two credentials.
      familyId: result.response.familyId,
      provisionedAt: result.response.provisionedAt,
      expiresIn: result.response.expiresIn,
    };
  }
  // `superseded` (409) included deliberately: another client won the race, so
  // there is NOTHING to hand the host and the winner's credential is already on
  // its way. Retrying here would mint a third credential and retire the winner's.
  return { kind: "unavailable" };
}
