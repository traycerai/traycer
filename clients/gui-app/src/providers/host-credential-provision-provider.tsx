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

/** Silent delegated host-credential mint, mounted once. Every `WsStreamClient` reaches one runner, so one mint is in flight per host. Failure is silent: the host keeps the connection's credential lease. */
export function HostCredentialProvisionProvider(props: {
  readonly children: ReactNode;
}): ReactNode {
  const binding = useHostBinding();
  const directory = useHostDirectory();
  const userId = useAuthStore((s) => s.contextMetadata?.userId ?? null);
  /** Read at mint time rather than closed over, so a runner registered under one identity cannot mint under another. */
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
          // Identity changed mid-mint. Drop the departing user's credential so
          // it never reaches a transport now serving someone else.
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
    // Re-register when binding or directory identity changes. Swapping the
    // runner cannot disturb an in-flight mint.
  }, [binding, directory]);

  // Scope to identity, not host binding. Watching the binding would hand the
  // next user the previous user's in-flight mint.
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
