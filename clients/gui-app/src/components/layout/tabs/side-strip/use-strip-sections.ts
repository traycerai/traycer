import { useContext, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import type { HostNotificationSeverity } from "@traycer/protocol/host/notifications/contracts";
import { NotificationIndicatorsContext } from "@/components/notifications/notification-indicator-context";
import { useAccountActivityCoverage } from "@/hooks/agent/use-account-activity-coverage";
import { useEpicWaitingReasons } from "@/hooks/epic/use-epic-activity-status";
import { EMPTY_EPIC_AGENT_ACTIVITY } from "@/lib/agent-activity";
import { notificationEntityFromPayload } from "@/lib/notifications";
import {
  getEpicAgentActivity,
  useAgentActivityStore,
} from "@/stores/agent-activity-store";
import { useAppLocalNotificationsStore } from "@/stores/notifications/app-local-notifications-store";
import {
  useMergedNotificationRows,
  type MergedNotificationRow,
} from "@/stores/notifications/merged-notifications";
import type { NeedsYouItem } from "@/stores/notifications/needs-you-items";
import { selectNotificationIndicatorState } from "@/stores/notifications/notification-indicator-state";
import { flattenStripItemRefs, tabRefKey } from "@/stores/tabs/layout";
import type { HeaderTab } from "@/stores/tabs/types";
import type { TabStripController } from "../tab-strip-controller";
import { stripRowsOf } from "../tab-strip-rows";
import { withWaitingIndicator } from "../tab-waiting";
import { sideTabLiveAgentsOf } from "./side-tab-live-agents";
import { StripNeedsYouContext } from "./strip-needs-you-context";
import {
  groupEntriesBySection,
  moreUrgentSection,
  promptEntriesOf,
  stripTaskRowOf,
  type ReviewOutcome,
  type ReviewTimes,
  type StripSectionGroup,
  type StripTabEntry,
} from "./strip-sections";

const NO_ITEMS: ReadonlyArray<NeedsYouItem> = [];
const NO_REVIEW_TIMES: ReviewTimes = { done: null, failed: null };

/** One strip item's tabs (two for a split pair) in strip order. */
interface StripItemTabs {
  readonly itemId: string;
  readonly groupColor: string | null;
  readonly tabs: ReadonlyArray<HeaderTab>;
}

/**
 * The strip's items in the user's order, every tab group flattened: a member
 * of a collapsed group is here, carrying the group's color.
 */
function stripItemTabsOf(
  controller: Pick<
    TabStripController,
    "headerItemIds" | "layoutItems" | "groups" | "customizations" | "tabs"
  >,
): ReadonlyArray<StripItemTabs> {
  const { headerItemIds, layoutItems, groups, customizations, tabs } =
    controller;
  const tabsByKey = new Map(tabs.map((tab) => [tabRefKey(tab), tab]));
  return stripRowsOf(
    headerItemIds,
    layoutItems,
    groups,
    customizations,
  ).flatMap((row) => {
    const item = layoutItems.at(row.stripIndex);
    if (item === undefined) return [];
    const itemTabs = flattenStripItemRefs(item).flatMap(
      (ref) => tabsByKey.get(tabRefKey(ref)) ?? [],
    );
    return itemTabs.length === 0
      ? []
      : [
          {
            itemId: row.itemId,
            groupColor: row.group?.group.color ?? null,
            tabs: itemTabs,
          },
        ];
  });
}

const OUTCOME_OF_SEVERITY: Readonly<
  Partial<Record<HostNotificationSeverity, ReviewOutcome>>
> = { done: "done", failure: "failed" };

/**
 * Per task, the time of the latest unread notification row of each outcome:
 * the moment a task in To review finished.
 */
function latestUnreadTimesOf(
  rows: ReadonlyArray<MergedNotificationRow>,
): Readonly<Record<ReviewOutcome, ReadonlyMap<string, number>>> {
  const latest: Record<ReviewOutcome, Map<string, number>> = {
    done: new Map(),
    failed: new Map(),
  };
  for (const row of rows) {
    const outcome = OUTCOME_OF_SEVERITY[row.severity];
    const epicId = notificationEntityFromPayload(row.payload)?.epicId;
    if (row.readAt !== null || outcome === undefined || epicId === undefined) {
      continue;
    }
    latest[outcome].set(
      epicId,
      Math.max(latest[outcome].get(epicId) ?? row.createdAt, row.createdAt),
    );
  }
  return latest;
}

/**
 * The strip's entries grouped into the Activity view's sections, in the order
 * Needs you, To review, Working, Idle; a section with nothing in it is left
 * out. Inside a section the entries keep the user's tab order, a split pair is
 * one entry in the section of its more urgent half, and a task that is waiting
 * on the person but has no tab in the strip follows the strip's own entries in
 * Needs you. Read it under the strip's `StripNeedsYouScope` and
 * `TabStripIndicatorScope`.
 *
 * A task's section comes from the indicator its row draws: the strip's
 * notification indicators merged with its warm session's own waiting reason
 * (`withWaitingIndicator`, as `useStripTabItem` does), so a row that shows an
 * Approve or Reply chip is in Needs you.
 */
export function useStripSections(
  controller: Pick<
    TabStripController,
    "headerItemIds" | "layoutItems" | "groups" | "customizations" | "tabs"
  >,
): ReadonlyArray<StripSectionGroup> {
  const { headerItemIds, layoutItems, groups, customizations, tabs } =
    controller;
  const { byEpic, pinned } = useContext(StripNeedsYouContext);
  const indicators = useContext(NotificationIndicatorsContext);
  const localRows = useAppLocalNotificationsStore((state) => state.byId);
  const coverage = useAccountActivityCoverage();
  const notificationRows = useMergedNotificationRows();
  const stripItems = useMemo(
    () =>
      stripItemTabsOf({
        headerItemIds,
        layoutItems,
        groups,
        customizations,
        tabs,
      }),
    [headerItemIds, layoutItems, groups, customizations, tabs],
  );
  const epicIds = useMemo(
    () => [
      ...new Set(
        stripItems.flatMap((item) =>
          item.tabs.flatMap((tab) => (tab.kind === "epic" ? [tab.epicId] : [])),
        ),
      ),
    ],
    [stripItems],
  );
  const activityByEpic = useAgentActivityStore(
    useShallow(
      () => new Map(epicIds.map((id) => [id, getEpicAgentActivity(id)])),
    ),
  );
  const waitingByEpic = useEpicWaitingReasons(epicIds);
  const unreadTimes = useMemo(
    () => latestUnreadTimesOf(notificationRows),
    [notificationRows],
  );
  return useMemo(() => {
    const entries = stripItems.map((item): StripTabEntry => {
      const members = item.tabs.map((tab) => {
        const epicId = tab.kind === "epic" ? tab.epicId : null;
        return {
          tab,
          row: stripTaskRowOf({
            indicator: withWaitingIndicator(
              selectNotificationIndicatorState(
                { byId: localRows },
                { epicId: epicId ?? tab.id },
                null,
                indicators,
              ),
              epicId === null ? null : (waitingByEpic.get(epicId) ?? null),
            ),
            agents: sideTabLiveAgentsOf(
              (epicId === null ? undefined : activityByEpic.get(epicId)) ??
                EMPTY_EPIC_AGENT_ACTIVITY,
              coverage,
            ),
            needsYou:
              epicId === null ? NO_ITEMS : (byEpic.get(epicId) ?? NO_ITEMS),
            reviewTimes:
              epicId === null
                ? NO_REVIEW_TIMES
                : {
                    done: unreadTimes.done.get(epicId) ?? null,
                    failed: unreadTimes.failed.get(epicId) ?? null,
                  },
          }),
        };
      });
      return {
        kind: "tabs",
        itemId: item.itemId,
        section: members
          .map((member) => member.row.section)
          .reduce(moreUrgentSection),
        groupColor: item.groupColor,
        members,
      };
    });
    return groupEntriesBySection([
      ...entries,
      ...promptEntriesOf(pinned, new Set(epicIds)),
    ]);
  }, [
    stripItems,
    epicIds,
    localRows,
    indicators,
    activityByEpic,
    waitingByEpic,
    coverage,
    byEpic,
    pinned,
    unreadTimes,
  ]);
}
