import { useMemo } from "react";
import { useNotificationIndicators } from "@/hooks/notifications/use-notification-indicators-query";
import { displayTitle } from "@/lib/display-title";
import { useRegisteredEpicTitle } from "@/lib/epic-selectors";
import type { SurfaceNotificationIndicators } from "@/stores/notifications/notification-indicator-state";
import type { SplitSide } from "@/stores/tabs/layout";
import type { HeaderTab } from "@/stores/tabs/types";

interface HeaderTabTitle {
  readonly resolvedTabName: string;
  readonly displayName: string;
}

export function useHeaderTabTitle(tab: HeaderTab): HeaderTabTitle {
  const liveEpicTitle = useRegisteredEpicTitle(
    tab.kind === "epic" ? tab.epicId : null,
  );
  const resolvedTabName = liveEpicTitle ?? tab.name;
  return {
    resolvedTabName,
    displayName:
      tab.kind === "epic"
        ? displayTitle(resolvedTabName, "epic")
        : resolvedTabName,
  };
}

interface HeaderTabIndicators {
  readonly epicIds: ReadonlyArray<string>;
  readonly indicators: SurfaceNotificationIndicators;
}

export function useHeaderTabIndicators(
  tabs: ReadonlyArray<HeaderTab>,
): HeaderTabIndicators {
  const epicIds = useMemo(
    () => tabs.flatMap((tab) => (tab.kind === "epic" ? [tab.epicId] : [])),
    [tabs],
  );
  // The strip and its portalled preview observe the same batch/cache entry.
  // Epics are shared cloud entities, so their indicator scope is app-wide.
  const indicators = useNotificationIndicators({
    hostId: null,
    epicIds,
    chatIds: [],
    enabled: epicIds.length > 0,
  });
  return { epicIds, indicators };
}

export function splitSlotLabel(
  slot: Exclude<SplitSide, { readonly kind: "tab" }>,
): string {
  return slot.kind === "unavailable" ? slot.label : "Choose view";
}
