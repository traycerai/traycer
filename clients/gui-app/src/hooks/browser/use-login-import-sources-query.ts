import {
  queryOptions,
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import type {
  BrowserViewBridge,
  LoginImportSource,
} from "@traycer-clients/shared/platform/browser-view";
import { browserQueryKeys } from "@/lib/query-keys";

/**
 * The browsers and profiles this machine can import logins from. A listing is
 * `stat` calls and a `Local State` read on the desktop - no jar is opened and
 * nothing prompts - so it re-runs on every open of the dialog and is thrown
 * away when the dialog closes: the desktop mints a fresh id per source on
 * every listing, and a cached list would name ids the desktop no longer has.
 */
function loginImportSourcesQueryOptions(
  browserView: BrowserViewBridge | null,
  enabled: boolean,
) {
  return queryOptions<readonly LoginImportSource[]>({
    queryKey: browserQueryKeys.loginImportSources(browserView),
    queryFn: async () => {
      if (browserView === null) {
        throw new Error("This machine has no browser bridge.");
      }
      return browserView.listLoginImportSources();
    },
    enabled: enabled && browserView !== null,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnMount: "always",
    retry: false,
  });
}

export function useLoginImportSourcesQuery(args: {
  readonly browserView: BrowserViewBridge | null;
  readonly enabled: boolean;
}): UseQueryResult<readonly LoginImportSource[]> {
  return useQuery(
    loginImportSourcesQueryOptions(args.browserView, args.enabled),
  );
}
