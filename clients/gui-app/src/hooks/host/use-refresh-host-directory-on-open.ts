import { useEffect } from "react";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";

interface RefreshableHostDirectory {
  refresh(): Promise<readonly HostDirectoryEntry[]>;
}

export function useRefreshHostDirectoryOnOpen(
  open: boolean,
  directory: RefreshableHostDirectory | null,
): void {
  useEffect(() => {
    if (!open || directory === null) {
      return;
    }
    void directory.refresh();
  }, [directory, open]);
}
