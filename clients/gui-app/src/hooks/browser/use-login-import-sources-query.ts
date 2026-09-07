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

/** The browsers and profiles this machine can import logins from. */
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
