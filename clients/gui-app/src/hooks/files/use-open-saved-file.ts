import { useMutation, type UseMutationResult } from "@tanstack/react-query";
import { openSavedFile, type SavedFile } from "@/lib/files/save-blob-to-disk";
import { appLogger } from "@/lib/logger";
import { runnerMutationKeys } from "@/lib/query-keys";
import { toastFromRunnerError } from "@/lib/runner-error-toast";

/**
 * Opens a file {@link openSavedFile} wrote, via the desktop RunnerHost
 * bridge. Owns the query key and runner-error toast so the post-save
 * "Open file" action never talks to the bridge ad hoc.
 */
export function useOpenSavedFile(): UseMutationResult<void, Error, SavedFile> {
  return useMutation<void, Error, SavedFile>({
    mutationKey: runnerMutationKeys.openSavedFile(),
    mutationFn: openSavedFile,
    onError: (error, saved) => {
      appLogger.errorSummary(
        "[saved-file] open failed",
        { name: saved.name },
        error,
      );
      toastFromRunnerError(error, `Could not open ${saved.name}`);
    },
  });
}
