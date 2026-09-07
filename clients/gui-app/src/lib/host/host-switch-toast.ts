import { toast } from "sonner";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";

/** The label a host announcement names, falling back to the id for an entry the registry has not labelled yet. */
export function hostSwitchLabel(entry: HostDirectoryEntry): string {
  return entry.label.length > 0 ? entry.label : entry.hostId;
}

/** The one announcement for a host switch the user did not click. */
export function toastHostSwitched(
  entry: HostDirectoryEntry,
  reason: string,
): void {
  toast.info(`Switched to ${hostSwitchLabel(entry)}`, { description: reason });
}
