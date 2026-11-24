import { recordNegotiatedHostMethods } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";

/**
 * `host-old` serves no `environment.status`: a released host from before the
 * Environment group.
 */
export function recordOldHost(): void {
  recordNegotiatedHostMethods("host-old", ["host.status"]);
}

/** The person has picked a Local row on that computer. */
export function pickOldHostLocal(): void {
  recordOldHost();
  useSettingsEnvironmentPickStore.setState({
    pick: { kind: "local", hostId: "host-old", hostName: "Old laptop" },
  });
}
