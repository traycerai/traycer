import { useMutation, type UseMutationResult } from "@tanstack/react-query";
import type {
  BrowserViewBridge,
  LoginImportRequest,
  LoginImportResult,
} from "@traycer-clients/shared/platform/browser-view";
import { browserMutationKeys } from "@/lib/query-keys";
import { toastFromRunnerError } from "@/lib/runner-error-toast";

/**
 * The Import click, which is ONE call: the desktop decrypts, writes its
 * durable jar, and pushes that jar to every host it holds a live browser
 * stream to, answering with the `notifiedHosts` that took it.
 *
 * The push is main's, not this renderer's, for the reason forget-all's frames
 * are: a jar frame speaks for the user's whole slice on a host, so a renderer
 * may ask for one and may not send one. It is needed at all because the write
 * runs with the cookie-delta observer muted - the deltas that carry an
 * ordinary sign-in never fire for an import.
 *
 * `retry: false` matters here more than anywhere: the write opens the OS
 * keystore, and a retry after a denied Keychain prompt is a second prompt the
 * user did not ask for. The bridge answers every failure as a result value, so
 * the only way into `onError` is the IPC itself failing.
 */
export function useLoginImportRun(
  browserView: BrowserViewBridge | null,
): UseMutationResult<LoginImportResult, Error, LoginImportRequest> {
  return useMutation<LoginImportResult, Error, LoginImportRequest>({
    mutationKey: browserMutationKeys.importLogins(),
    mutationFn: async (request) => {
      if (browserView === null) {
        throw new Error("This machine has no browser bridge.");
      }
      return browserView.importLogins(request);
    },
    retry: false,
    onError: (error) => toastFromRunnerError(error, "Couldn't import logins"),
  });
}
