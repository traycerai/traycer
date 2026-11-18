import { toast } from "sonner";
import type { IFileSaveHost } from "@traycer-clients/shared/platform/runner-host";
import {
  canOpenSavedFile,
  type SavedFile,
} from "@/lib/files/save-blob-to-disk";

/**
 * Which route committed the bytes, because it decides what the user is
 * truthfully told.
 *
 * `"save"` wrote the file itself - a desktop dialog, a browser download, the
 * phone's direct write into its documents directory. `"share"` handed it to an
 * OS chooser and another app decided what happened next; on the phone the bytes
 * the sheet is given live in the app's CACHE container, so nothing was saved
 * anywhere the user keeps files and claiming otherwise is a plain untruth.
 */
export type SavedFileRoute = "save" | "share";

/**
 * The one success toast for every "commit these bytes" flow (artifact markdown
 * export, usage image, Mermaid PNG, chat image). Shows `Saved <name>` or
 * `Shared <name>` per {@link SavedFileRoute} and, where the runtime can re-open
 * the file (Traycer Desktop, which learns the path from its native dialog), an
 * "Open file" action. The action fires `openSaved` — callers pass
 * `useOpenSavedFile().mutate` so the RunnerHost IPC stays on TanStack Query.
 * Browser and phone runtimes never learn the path, so they get the plain toast.
 *
 * The route is PASSED, not derived: a shell that owns a share sheet owns a
 * direct write too, so `fileSave` alone cannot say which of the two a given
 * call took.
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
