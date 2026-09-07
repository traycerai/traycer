import { toast } from "sonner";
import type { IFileSaveHost } from "@traycer-clients/shared/platform/runner-host";
import {
  canOpenSavedFile,
  type SavedFile,
} from "@/lib/files/save-blob-to-disk";

/** Which route committed the bytes, because it decides what the user is truthfully told. */
export type SavedFileRoute = "save" | "share";

/**
 * The one success toast for every "commit these bytes" flow (artifact markdown export, usage image, Mermaid PNG, chat image).
 * Shows `Saved <name>` or `Shared <name>` per {@link SavedFileRoute} and, where the runtime can re-open the file (Traycer Desktop, which learns the path from its native dialog), an "Open file" action.
 */
export function toastSavedFile(
  saved: SavedFile,
  openSaved: (saved: SavedFile) => void,
  fileSave: IFileSaveHost | null,
  route: SavedFileRoute,
): void {
  const message =
    route === "share" ? `Shared ${saved.name}` : `Saved ${saved.name}`;
  if (!canOpenSavedFile(saved, fileSave)) {
    toast.success(message);
    return;
  }
  toast.success(message, {
    action: {
      label: "Open file",
      onClick: () => {
        openSaved(saved);
      },
    },
  });
}
