import { useMemo, type ReactNode } from "react";
import { useSampleScene } from "@/components/sample-workspace/sample-scene-context";
import { flattenStripItemRefs, tabRefKey } from "@/stores/tabs/layout";
import {
  groupNeedsYouByEpic,
  useNeedsYouItems,
  type NeedsYouItem,
} from "@/stores/notifications/needs-you-items";
import type { TabStripController } from "../tab-strip-controller";
import { stripRowsOf } from "../tab-strip-rows";
import { useLiveAgentsInStrip } from "./strip-agents-mode";
import {
  NO_STRIP_NEEDS_YOU,
  StripNeedsYouContext,
  type StripNeedsYou,
} from "./strip-needs-you-context";

/** The tasks with a drawn row: a member of a collapsed group has none. */
function stripEpicIdsOf(
  controller: Pick<
    TabStripController,
    "headerItemIds" | "layoutItems" | "groups" | "customizations" | "tabs"
  >,
): ReadonlySet<string> {
  const { headerItemIds, layoutItems, groups, customizations, tabs } =
    controller;
  const tabsByKey = new Map(tabs.map((tab) => [tabRefKey(tab), tab]));
  const epicIds = new Set<string>();
  for (const row of stripRowsOf(
    headerItemIds,
    layoutItems,
    groups,
    customizations,
  )) {
    const item = layoutItems.at(row.stripIndex);
    if (row.hidden || item === undefined) continue;
    for (const ref of flattenStripItemRefs(item)) {
      const tab = tabsByKey.get(tabRefKey(ref));
      if (tab?.kind === "epic") epicIds.add(tab.epicId);
    }
  }
  return epicIds;
}

/**
 * The prompts waiting on the person, read once for the whole strip: grouped
 * by task for the rows nested under each task, and the rest, whose task has no
 * row, for the pinned block, so nothing shows twice. Empty while the strip does
 * not nest agents, and under the layout editor's sample scene, where the
 * person's own prompts are never read (B1) and the sample task's waiting agent
 * already shows under its row.
 */
export function StripNeedsYouScope(props: {
  readonly controller: TabStripController;
  readonly children: ReactNode;
}): ReactNode {
  const { headerItemIds, layoutItems, groups, customizations, tabs } =
    props.controller;
  const items = useNeedsYouItems();
  const shown = useLiveAgentsInStrip();
  const sample = useSampleScene();
  const value = useMemo((): StripNeedsYou => {
    if (!shown || sample) return NO_STRIP_NEEDS_YOU;
    const byEpic = groupNeedsYouByEpic(items);
    const nested = new Set<NeedsYouItem>();
    const epicIds = stripEpicIdsOf({
      headerItemIds,
      layoutItems,
      groups,
      customizations,
      tabs,
    });
    for (const epicId of epicIds) {
      for (const item of byEpic.get(epicId) ?? []) nested.add(item);
    }
    return { byEpic, pinned: items.filter((item) => !nested.has(item)) };
  }, [
    items,
    shown,
    sample,
    headerItemIds,
    layoutItems,
    groups,
    customizations,
    tabs,
  ]);
  return (
    <StripNeedsYouContext.Provider value={value}>
      {props.children}
    </StripNeedsYouContext.Provider>
  );
}
