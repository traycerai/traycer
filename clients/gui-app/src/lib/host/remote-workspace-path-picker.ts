import { create } from "zustand";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";

/**
 * Imperative "pick a workspace path" bridge for a remote host (Journey 3):
 * the folder lives on the box, so there is no native OS picker — the client
 * enters/pastes a path instead, backed by the `getHomeDir` / `validatePath` /
 * `listRecentWorkspaces` / `recordRecentWorkspace` operations of
 * `workspace.prepareFolders` v1.1 (T14, re-homed by T18).
 *
 * Mirrors `IRunnerHost.workspaceFolders.pickFolders(): Promise<readonly
 * string[]>` exactly, so `useWorkspaceFolderActions` can swap this in for the
 * native picker by `HostDirectoryEntry.kind` with no change to anything
 * downstream (`workspace.prepareFolders`, `addResolvedFolders`, …) — both
 * resolve to zero or one chosen paths.
 */
interface RemoteWorkspacePathPickerRequest {
  readonly client: HostClient<HostRpcRegistry>;
  readonly resolve: (paths: readonly string[]) => void;
}

interface RemoteWorkspacePathPickerState {
  readonly request: RemoteWorkspacePathPickerRequest | null;
  readonly settle: (paths: readonly string[]) => void;
}

export const useRemoteWorkspacePathPickerStore =
  create<RemoteWorkspacePathPickerState>((set, get) => ({
    request: null,
    settle: (paths) => {
      const current = get().request;
      if (current === null) {
        return;
      }
      set({ request: null });
      current.resolve(paths);
    },
  }));

/**
 * Opens the remote path-entry dialog and resolves with the user's chosen
 * path (`[resolvedPath]`) or `[]` on cancel. Only one request is live at a
 * time — a second call while one is pending resolves the first with `[]`
 * (mirrors a native picker's own single-flight nature).
 */
export function openRemoteWorkspacePathPicker(
  client: HostClient<HostRpcRegistry>,
): Promise<readonly string[]> {
  return new Promise((resolve) => {
    const store = useRemoteWorkspacePathPickerStore.getState();
    if (store.request !== null) {
      store.settle([]);
    }
    useRemoteWorkspacePathPickerStore.setState({
      request: { client, resolve },
    });
  });
}
