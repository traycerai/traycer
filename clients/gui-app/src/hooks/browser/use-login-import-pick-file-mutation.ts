import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import type {
  BrowserViewBridge,
  LoginImportSource,
} from "@traycer-clients/shared/platform/browser-view";
import { browserMutationKeys, browserQueryKeys } from "@/lib/query-keys";
import { toastFromRunnerError } from "@/lib/runner-error-toast";

/**
 * "Import from a file…": the native picker runs in the desktop's main
 * process, so this renderer never sees a path - only the opaque source the
 * desktop registered for it, which is appended to the listing so the Pick
 * step can show it beside the discovered browsers. `null` is a cancelled
 * picker and changes nothing.
 */
export function useLoginImportPickFile(
  browserView: BrowserViewBridge | null,
): UseMutationResult<LoginImportSource | null, Error, void> {
  const queryClient = useQueryClient();
  return useMutation<LoginImportSource | null>({
    mutationKey: browserMutationKeys.pickLoginImportFile(),
    mutationFn: async () => {
      if (browserView === null) {
        throw new Error("This machine has no browser bridge.");
      }
      return browserView.pickLoginImportFile();
    },
    retry: false,
    onSuccess: (source) => {
      if (source === null) return;
      queryClient.setQueryData<readonly LoginImportSource[]>(
        browserQueryKeys.loginImportSources(browserView),
        (current) => [...(current ?? []), source],
      );
    },
    onError: (error) => toastFromRunnerError(error, "Couldn't open the file"),
  });
}
