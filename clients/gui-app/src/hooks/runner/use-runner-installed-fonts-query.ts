import { queryOptions, useQuery } from "@tanstack/react-query";
import { runnerQueryKeys } from "@/lib/query-keys/runner-mutation-keys";
import {
  getInstalledFontsBridge,
  type InstalledFont,
} from "@/lib/desktop-installed-fonts";

/**
 * Enumerates fonts installed on this machine for the Appearance font
 * pickers. Non-desktop shells (web, gui-app-dev) have no enumeration
 * bridge, so the query resolves an empty list instead of erroring - the
 * pickers already accept a free-typed font name as a fallback. The list is
 * effectively static for the session, so it is fetched once and never
 * considered stale.
 */
export function useRunnerInstalledFontsQuery() {
  return useQuery(
    queryOptions<readonly InstalledFont[]>({
      queryKey: runnerQueryKeys.installedFonts(),
      queryFn: async () => {
        const bridge = getInstalledFontsBridge();
        if (bridge === null) return [];
        return bridge.list();
      },
      staleTime: Infinity,
    }),
  );
}
