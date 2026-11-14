import { useCallback, useSyncExternalStore } from "react";
import { subscribeAnyHostRowChanged } from "@traycer-clients/shared/host-client/host-connection-registry";
import { isRemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import { useHostClient } from "@/lib/host";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useLocalTeamAdmissionStore } from "@/stores/host/local-team-admission-store";

/** A row arriving and a same-user admission change both move the answer. */
function subscribeWindowHostOwnership(onChange: () => void): () => void {
  const unsubscribeHost = subscribeAnyHostRowChanged(onChange);
  const unsubscribeAdmission = useLocalTeamAdmissionStore.subscribe(onChange);
  const unsubscribeAuth = useAuthStore.subscribe(onChange);
  return () => {
    unsubscribeHost();
    unsubscribeAdmission();
    unsubscribeAuth();
  };
}

/**
 * Whether the surface's host is a team's computer: a remote team row that is
 * not a sandbox, or this machine with the signed-in person admitted to it as
 * a team member (or that admission still being settled).
 *
 * Personal is never changed through a team's computer, and a call the
 * computer cannot check the caller's seat for is not offered through one.
 */
export function useWindowHostIsTeamComputer(): boolean {
  const client = useHostClient();
  const read = useCallback(() => {
    const entry = client.getActiveHost();
    if (entry === null) return false;
    if (isRemoteHostDirectoryEntry(entry)) {
      return entry.sandbox === null && entry.owner?.kind === "team";
    }
    if (entry.kind !== "local") return false;
    const userId = useAuthStore.getState().contextMetadata?.userId ?? null;
    const admission = useLocalTeamAdmissionStore
      .getState()
      .byHost.get(entry.hostId);
    return (
      admission?.userId === userId &&
      (admission.state === "admitted" ||
        admission.state === "required" ||
        admission.state === "unavailable")
    );
  }, [client]);
  return useSyncExternalStore(subscribeWindowHostOwnership, read, read);
}
