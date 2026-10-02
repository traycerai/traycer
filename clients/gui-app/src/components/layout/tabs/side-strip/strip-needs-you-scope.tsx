import { useMemo, type ReactNode } from "react";
import { useSampleScene } from "@/components/sample-workspace/sample-scene-context";
import {
  groupNeedsYouByEpic,
  useNeedsYouItems,
} from "@/stores/notifications/needs-you-items";
import {
  stripEpicIdsOf,
  stripItemTabsOf,
  type StripItemsSource,
} from "./strip-item-tabs";
import {
  NO_STRIP_NEEDS_YOU,
  StripNeedsYouContext,
  type StripNeedsYou,
} from "./strip-needs-you-context";

/**
 * The prompts waiting on the person, read once for the whole strip: grouped
 * by task for each task's own row, and the rest, whose task has no row in the
 * strip, as the Needs you rows of their own, so nothing shows twice. Read in
 * every view, since the Needs you task count counts a task with no row too.
 * Empty under the layout editor's sample scene, where the person's own
 * prompts are never read (B1).
 */
export function StripNeedsYouScope(props: {
  readonly controller: StripItemsSource;
  readonly children: ReactNode;
}): ReactNode {
  const { headerItemIds, layoutItems, groups, customizations, tabs } =
    props.controller;
  const items = useNeedsYouItems();
  const sample = useSampleScene();
  const value = useMemo((): StripNeedsYou => {
    if (sample) return NO_STRIP_NEEDS_YOU;
    const epicIds = stripEpicIdsOf(
      stripItemTabsOf({
        headerItemIds,
        layoutItems,
        groups,
        customizations,
        tabs,
      }),
    );
    const byEpic = groupNeedsYouByEpic(items);
    const nested = new Set(
      [...epicIds].flatMap((epicId) => byEpic.get(epicId) ?? []),
    );
    return { byEpic, rowless: items.filter((item) => !nested.has(item)) };
  }, [items, sample, headerItemIds, layoutItems, groups, customizations, tabs]);
  return (
    <StripNeedsYouContext.Provider value={value}>
      {props.children}
    </StripNeedsYouContext.Provider>
  );
}
