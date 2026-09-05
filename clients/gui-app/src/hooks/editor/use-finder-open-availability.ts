import { useEditorOpenPathsSupportsV11 } from "@/hooks/editor/use-editor-open-paths-version";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { isMac } from "@/lib/keybindings/platform";
import { isMobileApp } from "@/lib/mobile-app";

/**
 * Whether a Finder action may be offered for `hostId`. Four conditions, each
 * answering a different question:
 *
 * - the host is the LOCAL one - `editor.openPaths` opens a window on the
 *   machine it is sent to, so a Finder window on a remote host is one nobody
 *   can see;
 * - the client is a Mac, which with a local host is also the host's platform,
 *   and Finder exists on no other;
 * - not the installed mobile app - an iPad's user agent contains "Macintosh",
 *   so `isMac()` alone reports true there;
 * - the host negotiated a minor that carries the literal.
 */
export function useFinderOpenAvailability(hostId: string | null): boolean {
  const hostEntry = useHostDirectoryEntry(hostId);
  const targetNegotiated = useEditorOpenPathsSupportsV11(hostId);
  const hostIsLocal =
    hostEntry !== null &&
    (hostEntry.kind === "local" || hostEntry.kind === "mock");
  return hostIsLocal && targetNegotiated && isMac() && !isMobileApp();
}
