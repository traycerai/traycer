import { isRemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import type { DeadTileReason } from "@/components/epic-canvas/renderers/dead-tile-banner";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { sandboxDestroyedLine } from "@/lib/sandboxes/sandbox-row-lines";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useEndedSandboxHost } from "@/stores/sandboxes/ended-sandbox-hosts-store";

/**
 * How a tile's sandbox host ended, when a person ended it: stopped (or
 * stopping), from its directory entry, or destroyed by a member, with the
 * line saying who and when. `null` for any other host, or one that went away
 * on its own.
 */
export type HostSandboxEnd =
  | { readonly kind: "stopped" }
  | { readonly kind: "destroyed"; readonly line: string }
  | null;

export function useHostSandboxEnd(hostId: string): HostSandboxEnd {
  const entry = useHostDirectoryEntry(hostId);
  const ended = useEndedSandboxHost(hostId);
  const viewerUserId = useAuthStore((s) => s.contextMetadata?.userId ?? null);
  if (ended !== null) {
    return {
      kind: "destroyed",
      line: sandboxDestroyedLine(ended, viewerUserId),
    };
  }
  const state =
    entry !== null && isRemoteHostDirectoryEntry(entry)
      ? (entry.sandbox?.state ?? null)
      : null;
  return state === "stopped" || state === "stopping"
    ? { kind: "stopped" }
    : null;
}

/** The dead tile's reason for an unreachable host that ended this way. */
export function sandboxDeadTileReason(end: HostSandboxEnd): DeadTileReason {
  if (end === null) return "host-unreachable";
  return end.kind === "stopped" ? "sandbox-stopped" : "sandbox-destroyed";
}
