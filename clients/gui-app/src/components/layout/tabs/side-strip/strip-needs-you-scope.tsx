import { useMemo, type ReactNode } from "react";
import { useSampleScene } from "@/components/sample-workspace/sample-scene-context";
import {
  groupNeedsYouByEpic,
  useNeedsYouItems,
} from "@/stores/notifications/needs-you-items";
import type { TabStripController } from "../tab-strip-controller";
import { useSectionedStrip } from "./strip-agents-mode";
import { stripEpicIdsOf, stripItemTabsOf } from "./strip-item-tabs";
import {
  NO_STRIP_NEEDS_YOU,
  StripNeedsYouContext,
  type StripNeedsYou,
} from "./strip-needs-you-context";

/**
 * The prompts waiting on the person, read once for the whole strip: grouped
 * by task for each task's own row, and the rest, whose task has no row in the
 * strip, as the Needs you rows of their own, so nothing shows twice. Empty
 * while the strip is not sectioned, and under the layout editor's
 * sample scene, where the person's own prompts are never read (B1).
 */
export function StripNeedsYouScope(props: {
  readonly controller: TabStripController;
  readonly children: ReactNode;
}): ReactNode {
  const { headerItemIds, layoutItems, groups, customizations, tabs } =
    props.controller;
  const items = useNeedsYouItems();
  const shown = useSectionedStrip();
  const sample = useSampleScene();
  const value = useMemo((): StripNeedsYou => {
    if (!shown || sample) return NO_STRIP_NEEDS_YOU;
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
