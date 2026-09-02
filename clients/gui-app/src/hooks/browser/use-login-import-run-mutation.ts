import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import type {
  BrowserViewBridge,
  LoginImportRequest,
  LoginImportResult,
} from "@traycer-clients/shared/platform/browser-view";
import { useAddressableHostId } from "@/hooks/host/use-addressable-host-id";
import { browserMutationKeys, queryKeys } from "@/lib/query-keys";
import { toastFromRunnerError } from "@/lib/runner-error-toast";
import { BROWSER_SAVED_LOGIN_SITES_METHOD } from "./use-browser-saved-login-sites-query";

/** What `onMutate` captures for the completion callbacks. */
interface LoginImportRunContext {
  readonly hostId: string | null;
}

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
 *
 * On success the surface host's "Sites with saved logins" list is
 * invalidated: it is read from the host, which has just been handed the jar,
 * and its 30 s stale window would otherwise keep showing the pre-import list
 * behind a Done step that names the sites just added.
 */
export function useLoginImportRun(
  browserView: BrowserViewBridge | null,
): UseMutationResult<LoginImportResult, Error, LoginImportRequest> {
  const queryClient = useQueryClient();
  const hostId = useAddressableHostId();
  return useMutation<
    LoginImportResult,
    Error,
    LoginImportRequest,
    LoginImportRunContext
  >({
    mutationKey: browserMutationKeys.importLogins(),
    // The host the import was STARTED for. An import can sit on a Keychain
    // prompt for minutes, and the surface host can move in that time; the
    // list to refresh is the one that host serves, not whatever the render
    // resolves to when the result lands.
    onMutate: () => ({ hostId }),
    mutationFn: async (request) => {
      if (browserView === null) {
        throw new Error("This machine has no browser bridge.");
      }
      return browserView.importLogins(request);
    },
    retry: false,
    onSuccess: (result, _request, context) => {
      if (result.status !== "imported") return;
      void queryClient.invalidateQueries({
        queryKey: queryKeys.hostMethodScope(
          context.hostId,
          BROWSER_SAVED_LOGIN_SITES_METHOD,
        ),
      });
    },
    onError: (error) => toastFromRunnerError(error, "Couldn't import logins"),
  });
}
