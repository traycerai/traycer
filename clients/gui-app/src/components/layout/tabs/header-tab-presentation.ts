import { useLiveChatEpicIdsForEpics } from "@/lib/registries/epic-session-registry";
import {
  chatIndicatorHostScopes,
  type ChatIndicatorHostScope,
} from "@/lib/notifications/chat-indicator-scopes";
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
  readonly chatEpicIds: Readonly<Record<string, string>>;
  readonly chatScopes: ReadonlyArray<ChatIndicatorHostScope>;
}

export function useHeaderTabIndicators(
  tabs: ReadonlyArray<HeaderTab>,
): HeaderTabIndicators {
  const epicIds = useMemo(
    () => tabs.flatMap((tab) => (tab.kind === "epic" ? [tab.epicId] : [])),
    [tabs],
  );
  const chatEpicIds = useLiveChatEpicIdsForEpics(epicIds);
  const chatIds = useMemo(() => Object.keys(chatEpicIds), [chatEpicIds]);
  const epicHostIds = useMemo(() => {
    const hostIds: Map<string, ReadonlySet<string>> = new Map();
    for (const tab of tabs) {
      if (tab.kind !== "epic" || tab.hostId === null) continue;
      const epicHostIds = hostIds.get(tab.epicId);
      hostIds.set(
        tab.epicId,
        new Set(
          epicHostIds === undefined
            ? [tab.hostId]
            : [...epicHostIds, tab.hostId],
        ),
      );
    }
    return hostIds;
  }, [tabs]);
  const chatScopes = useMemo(
    () =>
      chatIndicatorHostScopes(
        chatIds.flatMap((chatId) => {
          const epicId = chatEpicIds[chatId];
          const hostIds = epicHostIds.get(epicId);
          return hostIds === undefined
            ? []
            : [...hostIds].map((hostId) => ({ hostId, chatId }));
        }),
      ),
    [chatEpicIds, chatIds, epicHostIds],
  );
  // The strip and its portalled preview observe the same batch/cache entry.
  // Epics are shared cloud entities, so their indicator scope is app-wide.
  const indicators = useNotificationIndicators({
    hostId: null,
    epicIds,
    chatIds: [],
    enabled: epicIds.length > 0,
  });
  return { epicIds, indicators, chatEpicIds, chatScopes };
}

export function splitSlotLabel(
  slot: Exclude<SplitSide, { readonly kind: "tab" }>,
): string {
  return slot.kind === "unavailable" ? slot.label : "Choose view";
}
