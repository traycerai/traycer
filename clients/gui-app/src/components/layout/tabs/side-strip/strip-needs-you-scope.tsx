import { useMemo, type ReactNode } from "react";
import { useSampleScene } from "@/components/sample-workspace/sample-scene-context";
import {
  groupNeedsYouByEpic,
  useNeedsYouItems,
} from "@/stores/notifications/needs-you-items";
import { useLiveAgentsInStrip } from "./strip-agents-mode";
import {
  NO_NEEDS_YOU_GROUPS,
  StripNeedsYouContext,
} from "./strip-needs-you-context";

/**
 * The prompts waiting on the person, grouped by their task, read once for the
 * whole row list rather than once per row. Empty while the strip does not
 * nest agents, and under the layout editor's sample scene, where the person's
 * own prompts are never read (B1).
 */
export function StripNeedsYouScope(props: {
  readonly children: ReactNode;
}): ReactNode {
  const items = useNeedsYouItems();
  const shown = useLiveAgentsInStrip();
  const sample = useSampleScene();
  const groups = useMemo(
    () => (shown && !sample ? groupNeedsYouByEpic(items) : NO_NEEDS_YOU_GROUPS),
    [items, shown, sample],
  );
  return (
    <StripNeedsYouContext.Provider value={groups}>
      {props.children}
    </StripNeedsYouContext.Provider>
  );
}
