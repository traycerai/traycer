import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { hostUnavailability } from "@traycer-clients/shared/host-client/remote-fetcher";

export function settingsHostDisplayName(host: HostDirectoryEntry): string {
  return host.label.length > 0 ? host.label : host.hostId;
}

/**
 * The picker row's label, with a suffix only when we can say something true.
 *
 * This used to append "(offline)" to every non-dialable row, which made the
 * label assert more than the directory knew. Three situations reach that
 * branch and only one of them is offline: a free-tier host that never attaches
 * by design is not down, and a host whose liveness read failed is not anything
 * yet — labelling either "(offline)" is the false-Offline claim, just spelled
 * as a suffix.
 *
 * `indeterminate` therefore gets NO suffix at all. A row that is quietly
 * un-pickable is a smaller lie than one that says the machine is off; the
 * honest status word for that host lives in Settings, where there is room for
 * it.
 */
export function settingsHostOptionLabel(host: HostDirectoryEntry): string {
  const label = settingsHostDisplayName(host);
  switch (hostUnavailability(host)) {
    case "offline":
      return `${label} (offline)`;
    case "plan-restricted":
      return `${label} (local only)`;
    case "indeterminate":
      return label;
    case null:
      return label;
  }
}
