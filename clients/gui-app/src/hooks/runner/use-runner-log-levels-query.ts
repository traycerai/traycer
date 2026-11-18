import { queryOptions, useQuery } from "@tanstack/react-query";
import { runnerQueryKeys } from "@/lib/query-keys/runner-mutation-keys";
import {
  getLogLevelsBridge,
  type LogLevelsSnapshot,
} from "@/lib/desktop-log-levels";

/**
 * Reads the three configurable log thresholds (desktop / cli / host) from the
 * desktop platform bridge. Disabled — and so a permanent no-op — outside the
 * desktop shell, where there is no bridge to read. `getLogLevelsBridge()` is
 * resolved inside the fetcher (not captured) so the cache key stays primitive.
 */
export function useRunnerLogLevelsQuery() {
  return useQuery(
    queryOptions<LogLevelsSnapshot>({
      queryKey: runnerQueryKeys.logLevels(),
      queryFn: () => {
        const bridge = getLogLevelsBridge();
        if (bridge === null) {
          throw new Error("Log levels are only available in the desktop app.");
        }
        return bridge.get();
      },
      enabled: getLogLevelsBridge() !== null,
      staleTime: 30_000,
    }),
  );
}
