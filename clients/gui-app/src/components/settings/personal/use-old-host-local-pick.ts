import { useCallback, useSyncExternalStore } from "react";
import { subscribeNegotiatedManifests } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { readNegotiatedMethodVersion } from "@/lib/host/read-negotiated-method-version";
import { useEnvironmentPick } from "@/stores/settings/settings-environment-pick-store";

/** What the pick says of its computer's release. */
type LocalPickHostAge =
  /** Not a Local pick. */
  | "none"
  /** A host that serves no `environment.status`, from before the Environment group. */
  | "old"
  | "current";

/**
 * The release of the computer a Local pick names, read from that host's own
 * negotiated manifest by its id: a Local pick names a computer, which need
 * not be the window's host or have a client yet. A Local pick implies a
 * recorded manifest, so there is no state to wait for. A Personal pick is
 * `none` whatever the window's host has negotiated, so an outage never
 * touches it.
 */
export function useLocalPickHostAge(): LocalPickHostAge {
  const pick = useEnvironmentPick();
  const hostId = pick.kind === "local" ? pick.hostId : null;
  const getSnapshot = useCallback((): LocalPickHostAge => {
    if (hostId === null) return "none";
    return readNegotiatedMethodVersion(hostId, "environment.status") === false
      ? "old"
      : "current";
  }, [hostId]);
  return useSyncExternalStore(subscribeNegotiatedManifests, getSnapshot);
}

/** Whether the pick is a Local row on a host that serves no `environment.status`. */
export function useOldHostLocalPick(): boolean {
  return useLocalPickHostAge() === "old";
}
