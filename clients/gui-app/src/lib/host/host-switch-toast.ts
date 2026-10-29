import { toast } from "sonner";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { hostNameFromLabel } from "@/lib/host/host-name";

/**
 * The label a host announcement names, or "the host" for an entry the
 * registry has not named yet - never its id.
 */
export function hostSwitchLabel(entry: HostDirectoryEntry): string {
  return hostNameFromLabel(entry.label, entry.hostId);
}

/**
 * The one announcement for a host switch the user did not click.
 *
 * Same `Switched to <host>` sentence the notification bridge shows when a
 * notification click moves the app-wide host (`notification-focus-bridge.tsx`
 * - binding another host is a bigger consequence than the gesture asked for,
 * so it is always stated). The description carries what that sentence cannot:
 * an automatic failover has no gesture behind it to explain itself, and a
 * window that silently re-homes itself reads as a bug.
 */
export function toastHostSwitched(
  entry: HostDirectoryEntry,
  reason: string,
): void {
  toast.info(`Switched to ${hostSwitchLabel(entry)}`, { description: reason });
}
