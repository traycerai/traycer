import { useCallback, useEffect } from "react";
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

/** This hook deliberately does not subscribe to `useHistorySearchStore`; ambient modal/home state must not wake the route tree. */
export function useRouteHistorySearchState(
  routeSearch: HistorySearchState,
): HistorySearchController {
  const router = useRouter();

  // Spreading the full state makes the patch an overwrite, so the store adopts the route's state verbatim rather than merging into whatever it held before.
  useEffect(() => {
    useHistorySearchStore.getState().update({ ...routeSearch });
  }, [routeSearch]);

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

export function useAmbientHistorySearchState(): HistorySearchController {
  const search = useHistorySearchStore((state) => state.search);
  const update = useHistorySearchStore((state) => state.update);
  const clear = useHistorySearchStore((state) => state.clear);

  return { search, update, clear };
}
