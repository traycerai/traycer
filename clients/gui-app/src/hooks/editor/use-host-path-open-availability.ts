import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";

/**
 * Host path openers launch applications on the machine serving the file.
 * Offer them only for this client's local host; remote clients (including
 * mobile) cannot use that window. An unresolved host offers no action.
 */
export function useHostPathOpenAvailability(hostId: string | null): boolean {
  const hostEntry = useHostDirectoryEntry(hostId);
  return (
    hostEntry !== null &&
    (hostEntry.kind === "local" || hostEntry.kind === "mock")
  );
}
