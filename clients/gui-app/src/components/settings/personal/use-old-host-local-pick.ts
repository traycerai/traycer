import { useCallback, useSyncExternalStore } from "react";
import { subscribeNegotiatedManifests } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { readNegotiatedMethodVersion } from "@/lib/host/read-negotiated-method-version";
import { useEnvironmentPick } from "@/stores/settings/settings-environment-pick-store";

/**
 * Whether the pick is a Local row on a host that serves no
 * `environment.status`: a host from before the Environment group, whose
 * computer pages are its own and editable. Read from the negotiated manifest
 * of the picked host itself, by its id: a Local pick names a computer, which
 * need not be the window's host or have a client yet.
 */
export function useOldHostLocalPick(): boolean {
  const pick = useEnvironmentPick();
  const hostId = pick.kind === "local" ? pick.hostId : null;
  const getSnapshot = useCallback(
    (): boolean =>
      hostId !== null &&
      readNegotiatedMethodVersion(hostId, "environment.status") === false,
    [hostId],
  );
  return useSyncExternalStore(subscribeNegotiatedManifests, getSnapshot);
}
