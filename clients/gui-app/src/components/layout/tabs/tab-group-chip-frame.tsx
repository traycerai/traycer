import type { ReactNode } from "react";
import * as m from "motion/react-m";
import { useHeaderStripGroupPlacement } from "@/components/epic-canvas/dnd/dnd-store";
import { useGroupChromeMotion } from "./use-group-chrome-motion";

/**
 * The top bar's group chip, with its margins, as one frame. The drag model
 * measures the frame (`data-strip-group-chip-frame`) as where the group begins,
 * and while a drag lays the strip out the frame moves with the group's tabs, so
 * a tab dragged across the group slides past its chip and not over it.
 */
export function TabGroupChipFrame(props: {
  readonly groupId: string;
  readonly children: ReactNode;
}): ReactNode {
  const chrome = useGroupChromeMotion(
    useHeaderStripGroupPlacement(props.groupId, null),
  );
  return (
    <m.div
      data-strip-group-chip-frame={props.groupId}
      className="flex shrink-0 self-stretch"
      style={{ x: chrome.offset, opacity: chrome.visible ? 1 : 0 }}
    >
      {props.children}
    </m.div>
  );
}
