import { useEffect } from "react";
import { isRemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import { buildHostStreamClient } from "@/hooks/host/use-host-stream-client-for";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { useRequestContextUserId } from "@/hooks/host/use-request-context-user-id";
import { useHostBinding } from "@/lib/host/runtime";
import { useStreamAuthRevalidator } from "@/lib/host/stream-auth-revalidator";
import { useRunnerHost } from "@/providers/use-runner-host";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";
import { useHostDoorState } from "@/stores/host/host-door-state-store";

/**
 * While `hostId`'s door state is nobody-signed-in, holds a started session to
 * that computer, so the surface showing the state keeps it dialing on its
 * ladder: a sign-in there is seen at the next rung, and Try again has a wait to
 * bring to now. It is the session every other builder of this computer shares,
 * so the hold opens no second socket.
 *
 * Built like `useHostStreamClientBindingFor`'s client, except that it starts
 * the session: a surface can show this state after the session it was raised
 * on has closed, and nothing else may be dialing that computer.
 */
export function useHoldNobodySignedInSession(hostId: string | null): void {
  const globalClient = useHostBinding()?.hostClient ?? null;
  const auth = useStreamAuthRevalidator();
  const { authnBaseUrl, hostTokens } = useRunnerHost();
  const userId = useRequestContextUserId(globalClient);
  const entry = useHostDirectoryEntry(hostId);
  const nobodySignedIn = useHostDoorState(hostId)?.kind === "nobody-signed-in";

  useEffect(() => {
    if (
      !nobodySignedIn ||
      globalClient === null ||
      userId === null ||
      entry === null ||
      !isRemoteHostDirectoryEntry(entry) ||
      entry.websocketUrl === null
    )
      return;
    const endpoint = { hostId: entry.hostId, websocketUrl: entry.websocketUrl };
    const client = buildHostStreamClient({
      target: entry,
      endpoint: () => endpoint,
      bearer: () => globalClient.getRequestContext()?.credentials ?? null,
      cloudAuthorized: () =>
        authorizesCloudCapability(useAuthStore.getState().status),
      authnBaseUrl,
      auth,
      hostTokens,
      userId,
      proactiveWakeEligible: true,
      autoStart: true,
      watchHostTokens: true,
    });
    return () => {
      client?.close("nobody-signed-in-hold-released");
    };
  }, [
    auth,
    authnBaseUrl,
    entry,
    globalClient,
    hostTokens,
    nobodySignedIn,
    userId,
  ]);
}
