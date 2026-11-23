import { recordNegotiatedHostMethods } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";

/**
 * The person has picked a Local row on a computer whose host serves no
 * `environment.status`: a released host from before the Environment group.
 */
export function pickOldHostLocal(): void {
  recordNegotiatedHostMethods("host-old", ["host.status"]);
  useSettingsEnvironmentPickStore.setState({
    pick: { kind: "local", hostId: "host-old", hostName: "Old laptop" },
  });
}
