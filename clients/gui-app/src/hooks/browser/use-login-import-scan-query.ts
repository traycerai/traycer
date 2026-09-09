import {
  queryOptions,
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import type {
  BrowserViewBridge,
  LoginImportScan,
} from "@traycer-clients/shared/platform/browser-view";
import { browserQueryKeys } from "@/lib/query-keys";

/**
 * What one source holds: sites, counts, and what stands in the way. Metadata
 * only on the desktop side - no keystore is opened - so the Choose-sites step
 * can render before any prompt has fired.
 *
 * `retry: false` is load-bearing rather than tidy: Safari's scan can be
 * refused by macOS until Full Disk Access is granted, and a retry there is a
 * second refusal the user did not ask for, not a recovery.
 */
function loginImportScanQueryOptions(
  browserView: BrowserViewBridge | null,
  sourceId: string | null,
) {
  return queryOptions<LoginImportScan>({
    queryKey: browserQueryKeys.loginImportScan(browserView, sourceId),
    queryFn: async () => {
      if (browserView === null || sourceId === null) {
        throw new Error("There is no login-import source to scan.");
      }
      return browserView.scanLoginImportSource(sourceId);
    },
    enabled: browserView !== null && sourceId !== null,
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  });
}

export function useLoginImportScanQuery(args: {
  readonly browserView: BrowserViewBridge | null;
  readonly sourceId: string | null;
}): UseQueryResult<LoginImportScan> {
  return useQuery(loginImportScanQueryOptions(args.browserView, args.sourceId));
}
