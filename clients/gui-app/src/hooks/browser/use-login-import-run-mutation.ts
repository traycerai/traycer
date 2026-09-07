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

/** Renderer may ask for a jar, never send one. retry false: a denied Keychain prompt must not retry. Incomplete import still invalidates the saved-logins list. */
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
    // The host the import was STARTED for.
    onMutate: () => ({ hostId }),
    mutationFn: async (request) => {
      if (browserView === null) {
        throw new Error("This machine has no browser bridge.");
      }
      return browserView.importLogins(request);
    },
    retry: false,
    onSuccess: (result, _request, context) => {
      if (!changedTheJar(result)) return;
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

/** A completed import, or one that stopped part-way with cookies written. */
function changedTheJar(result: LoginImportResult): boolean {
  if (result.status === "imported") return true;
  return result.status === "blocked" && result.reason === "incomplete";
}
