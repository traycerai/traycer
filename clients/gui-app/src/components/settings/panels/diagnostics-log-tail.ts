import { queryOptions, useQuery } from "@tanstack/react-query";
import {
  runnerQueryKeys,
  supportBridgeQueryScopeId,
} from "@/lib/query-keys/runner-mutation-keys";
import type {
  DesktopSupportBridge,
  DesktopSupportSnapshot,
} from "@/lib/windows/types";

/**
 * The non-component half of the shared log reader.
 *
 * Split from `diagnostics-log-entries.tsx` for `react-refresh`: a `.tsx` module
 * that exports anything other than components loses fast refresh for the whole
 * file, and the lint that says so is an error here.
 */
export const LOG_TAIL_LINES = 100;

/** What an expanded row has to show, whichever transport produced it. */
export type LogTailView =
  | { readonly status: "loading" }
  | { readonly status: "error" }
  /** The host advertised the file, then could not read it back. */
  | { readonly status: "missing" }
  | { readonly status: "ready"; readonly lines: readonly string[] };

/**
 * The desktop support snapshot, read by BOTH Diagnostics pages.
 *
 * One query key, so the two never issue separate reads for the same answer:
 * the app page takes the snapshot's `desktop` entry and the host page's
 * local-bridge fallback takes the rest.
 */
export function useSupportSnapshotQuery(support: DesktopSupportBridge) {
  return useQuery(
    queryOptions<DesktopSupportSnapshot>({
      queryKey: runnerQueryKeys.supportLogList(
        supportBridgeQueryScopeId(support),
      ),
      queryFn: () => support.getSnapshot(),
      staleTime: 60_000,
    }),
  );
}
