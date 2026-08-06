import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";

export function settingsHostDisplayName(host: HostDirectoryEntry): string {
  return host.label.length > 0 ? host.label : host.hostId;
}

export function settingsHostOptionLabel(host: HostDirectoryEntry): string {
  const label = settingsHostDisplayName(host);
  return host.status === "unavailable" ? `${label} (offline)` : label;
}
