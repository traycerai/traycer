import { useCallback } from "react";
import {
  type RouterHistory,
  type UseNavigateResult,
  useRouter,
} from "@tanstack/react-router";
import {
  navigateNestedFocus,
  type NavigateNestedFocus,
} from "@/lib/epic-nested-focus-navigation";

interface NestedFocusRouterLike {
  readonly history: RouterHistory;
  readonly navigate: UseNavigateResult<string>;
  readonly state: {
    readonly location: {
      readonly pathname: string;
      readonly search: Readonly<Record<string, unknown>>;
    };
  };
}

export function useEpicNestedFocusNavigation(): NavigateNestedFocus {
  const router: unknown = useRouter({ warn: false });
  return useCallback(
    (targetEpicId, targetTabId, prepare) => {
      if (!isNestedFocusRouterLike(router)) {
        const target = prepare();
        return target;
      }
      return navigateNestedFocus(
        {
          history: router.history,
          navigate: router.navigate,
          getLocation: () => ({
            pathname: router.state.location.pathname,
            search: router.state.location.search,
          }),
        },
        { epicId: targetEpicId, tabId: targetTabId },
        prepare,
      );
    },
    [router],
  );
}

function isNestedFocusRouterLike(
  value: unknown,
): value is NestedFocusRouterLike {
  if (!isRecord(value)) return false;
  if (!("history" in value) || !isRecord(value.history)) return false;
  if (typeof value.navigate !== "function") return false;
  if (!isRecord(value.state)) return false;
  if (!isRecord(value.state.location)) return false;
  if (typeof value.state.location.pathname !== "string") return false;
  return isRecord(value.state.location.search);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
