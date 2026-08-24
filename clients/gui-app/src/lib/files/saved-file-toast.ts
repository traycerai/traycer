import { toast } from "sonner";
import {
  canOpenSavedFile,
  openSavedFile,
  type SavedFile,
} from "@/lib/files/save-blob-to-disk";
import { appLogger } from "@/lib/logger";
import { toastFromRunnerError } from "@/lib/runner-error-toast";

/**
 * The one success toast for every "save to disk" flow (artifact markdown
 * export, usage image, Mermaid PNG, chat image). Shows `Saved <name>` and,
 * where the runtime can re-open the file (Traycer Desktop, which learns the
 * path from its native dialog), an "Open file" action that launches it in
 * the OS default app. Browser runtimes never learn the path, so they get the
 * plain toast - callers don't branch, they just hand over what
 * `saveBlobToDisk` returned.
 */
export function toastSavedFile(saved: SavedFile): void {
  const message = `Saved ${saved.name}`;
  if (!canOpenSavedFile(saved)) {
    toast.success(message);
    return;
  }
  toast.success(message, {
    action: {
      label: "Open file",
      onClick: () => {
        openSavedFile(saved).catch((error: unknown) => {
          appLogger.errorSummary(
            "[saved-file] open failed",
            { name: saved.name },
            error,
          );
          toastFromRunnerError(error, `Could not open ${saved.name}`);
        });
      },
    },
  });
}
