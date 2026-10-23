import { useCallback } from "react";
import {
  mintNewEpicTerminalTile,
  type TerminalLaunchTarget,
} from "@/components/epic-canvas/sidebar/new-terminal-tile-ref";
import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { useTerminalWorkspaceBindingsForClient } from "@/hooks/worktree/use-worktree-list-bindings-for-epic-query";
import { tileIntent } from "@/lib/canvas/tile-open/intent";
import { dialableHostEndpoint } from "@/lib/host/transport-key";

/**
 * A folderless terminal on a named host, the New terminal path's launch with
 * no folder bound: the host's default cwd from its directory bindings for the
 * epic (`terminal.plain.create` needs a real cwd). `null` while the host is
 * not dialable (a sandbox still booting), has not answered, or predates
 * folderless workspaces.
 */
export function useFolderlessTerminalTarget(
  epicId: string,
  hostId: string | null,
): TerminalLaunchTarget | null {
  const namedClient = useHostClientForHostId(hostId);
  const dialable = dialableHostEndpoint(useHostDirectoryEntry(hostId)) !== null;
  const bindings = useTerminalWorkspaceBindingsForClient({
    client: hostId === null ? null : namedClient,
    epicId,
    enabled: hostId !== null && dialable,
  });
  const cwd = bindings.data?.folderlessCwd ?? null;
  if (hostId === null || !dialable || cwd === null || cwd.length === 0) {
    return null;
  }
  return { hostId, cwd };
}

/** Opens a folderless terminal tile on `hostId` in the epic, once it can. */
export function useOpenFolderlessEpicTerminal(
  epicId: string,
  hostId: string | null,
): (() => void) | null {
  const target = useFolderlessTerminalTarget(epicId, hostId);
  const { openTile } = useEpicTileNavigation();
  const open = useCallback(() => {
    if (target === null) return;
    openTile(
      tileIntent(
        mintNewEpicTerminalTile({ ...target, epicId }),
        { epicId },
        "explicit",
        "direct_ui",
      ),
    );
  }, [epicId, openTile, target]);
  return target === null ? null : open;
}
