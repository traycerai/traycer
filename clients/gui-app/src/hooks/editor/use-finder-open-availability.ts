import { useEditorOpenPathsSupportsV11 } from "@/hooks/editor/use-editor-open-paths-version";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { isMac } from "@/lib/keybindings/platform";
import { isMobileApp } from "@/lib/mobile-app";

/**
 * Finder only when the host is local, the client is Mac, not the installed mobile app (`isMac` is true on iPad), and the negotiated minor carries the literal.
 */
export function useFinderOpenAvailability(hostId: string | null): boolean {
  const hostEntry = useHostDirectoryEntry(hostId);
  const targetNegotiated = useEditorOpenPathsSupportsV11(hostId);
  const hostIsLocal =
    hostEntry !== null &&
    (hostEntry.kind === "local" || hostEntry.kind === "mock");
  return hostIsLocal && targetNegotiated && isMac() && !isMobileApp();
}
