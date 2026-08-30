import { toast } from "sonner";
import type { IFileSaveHost } from "@traycer-clients/shared/platform/runner-host";
import {
  canOpenSavedFile,
  type SavedFile,
} from "@/lib/files/save-blob-to-disk";

/**
 * The one success toast for every "save to disk" flow (artifact markdown
 * export, usage image, Mermaid PNG, chat image). Shows `Saved <name>` and,
 * where the runtime can re-open the file (Traycer Desktop, which learns the
 * path from its native dialog), an "Open file" action. The action fires
 * `openSaved` — callers pass `useOpenSavedFile().mutate` so the RunnerHost
 * IPC stays on TanStack Query. Browser and phone runtimes never learn the
 * path, so they get the plain toast.
 */
export function toastSavedFile(
  saved: SavedFile,
  openSaved: (saved: SavedFile) => void,
  fileSave: IFileSaveHost | null,
): void {
  const message = `Saved ${saved.name}`;
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
