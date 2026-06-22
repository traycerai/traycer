import { useCallback } from "react";
import { useRouter } from "@tanstack/react-router";
import {
  clearHistorySearchParams,
  historySearchToParams,
  parseHistorySearch,
  patchHistorySearch,
  type HistorySearchPatch,
  type HistorySearchState,
} from "@/lib/history-search";
import { useHistorySearchStore } from "@/stores/home/history-search-store";

export interface HistorySearchController {
  readonly search: HistorySearchState;
  readonly update: (patch: HistorySearchPatch) => void;
  readonly clear: () => void;
}

/**
 * Route-owned history search/filter/sort controller.
 *
 * `/epics` is the canonical, deep-linkable surface, so its search state stays in
 * that route's validated search params and updates navigate the route-local URL.
 * This hook deliberately does not subscribe to `useHistorySearchStore`; ambient
 * modal/home state must not wake the route tree.
 */
export function useRouteHistorySearchState(
  routeSearch: HistorySearchState,
): HistorySearchController {
  const router = useRouter();

  const update = useCallback(
    (patch: HistorySearchPatch): void => {
      void router.navigate({
        to: ".",
        search: (prev) => {
          const next = patchHistorySearch(parseHistorySearch(prev), patch);
          return {
            ...clearHistorySearchParams(prev),
            ...historySearchToParams(next),
          };
        },
      });
    },
    [router],
  );

  const clear = useCallback((): void => {
    void router.navigate({
      to: ".",
      search: (prev) => clearHistorySearchParams(prev),
    });
  }, [router]);

  return { search: routeSearch, update, clear };
}

/**
 * Ambient history search/filter/sort controller.
 *
 * History modal and home-embedded lists are root-level siblings of the page
 * content. Routing their high-frequency search through the URL would update the
 * root route and re-render the shell behind the modal on every keystroke, so
 * those surfaces use the persisted ambient store instead.
 */
export function useAmbientHistorySearchState(): HistorySearchController {
  const search = useHistorySearchStore((state) => state.search);
  const update = useHistorySearchStore((state) => state.update);
  const clear = useHistorySearchStore((state) => state.clear);

  return { search, update, clear };
}
