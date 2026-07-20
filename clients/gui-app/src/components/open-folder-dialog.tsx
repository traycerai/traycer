import { useEffect, useRef } from "react";
import {
  preparedWorkspaceFolderToWorkspaceFolderInfo,
  useWorkspaceFolderActions,
} from "@/hooks/workspace/use-workspace-folder-actions";
import { useAppDialogStore } from "@/stores/dialogs/app-dialog-store";
import { useWorkspaceFoldersStore } from "@/stores/workspace/workspace-folders-store";

export function OpenFolderDialog() {
  const activeDialog = useAppDialogStore((state) => state.activeDialog);
  const closeDialog = useAppDialogStore((state) => state.closeDialog);
  const { pickAndPrepareFolders } = useWorkspaceFolderActions();
  const addResolvedFolders = useWorkspaceFoldersStore(
    (state) => state.addResolvedFolders,
  );
  const openingRef = useRef(false);

  useEffect(() => {
    if (activeDialog !== "open-folder" || openingRef.current) {
      return;
    }

    openingRef.current = true;
    void pickAndPrepareFolders()
      .then((result) => {
        if (result === null) return;
        // hostId is the dispatch-time identity from pickAndPrepareFolders —
        // never re-read the mutable active host here.
        addResolvedFolders(
          result.folders.map((folder) =>
            preparedWorkspaceFolderToWorkspaceFolderInfo(folder, result.hostId),
          ),
        );
      })
      .finally(() => {
        openingRef.current = false;
        closeDialog();
      });
  }, [activeDialog, addResolvedFolders, closeDialog, pickAndPrepareFolders]);

  return null;
}
