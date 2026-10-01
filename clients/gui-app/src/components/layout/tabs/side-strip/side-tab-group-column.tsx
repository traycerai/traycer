import type { CSSProperties, ReactNode } from "react";
import * as m from "motion/react-m";
import {
  useHeaderStripGroupPlacement,
  useHeaderStripJoinsGroup,
} from "@/components/epic-canvas/dnd/dnd-store";
import { cn } from "@/lib/utils";
import { useGroupChromeMotion } from "../use-group-chrome-motion";
import {
  SIDE_TAB_GROUP_COLUMN_CLASS,
  SIDE_TAB_GROUP_FILL_LAYER_CLASS,
} from "./side-strip-tokens";
import { SideTabGroupDropEdge } from "./side-tab-group-drop-edge";

/**
 * A tab group in the collapsed rail: one tinted, rounded column around its
 * tiles (the group's header tile first in the Layered view). It carries the
 * group's colour, so the tiles in it draw no ring of their own.
 *
 * The drag model measures the column as the group's extent. While a drag lays
 * the strip out, the column's box stays where it is, and the fill and the
 * header tile are drawn where the layout puts them, so the group moves, grows
 * and shrinks with its tiles; while a drop would join the group the fill
 * brightens a step.
 */
export function SideTabGroupColumn(props: {
  readonly groupId: string;
  readonly color: string;
  /** The Activity view's section the column is in, which is also its drag lane. */
  readonly lane: string | null;
  /** The edge a drop's line sits outside of, when the drop lands beside the column. */
  readonly dropEdge: "top" | "bottom" | null;
  /** The Layered view's header tile; `null` in the Activity view. */
  readonly header: ReactNode;
  readonly children: ReactNode;
}): ReactNode {
  const joining = useHeaderStripJoinsGroup(props.groupId);
  const chrome = useGroupChromeMotion(
    useHeaderStripGroupPlacement(props.groupId, props.lane),
  );
  const hidden = chrome.visible ? 1 : 0;
  return (
    <div
      data-testid={`side-tab-group-column-${props.groupId}`}
      data-strip-group-extent={props.groupId}
      data-strip-lane={props.lane ?? undefined}
      data-joining={joining}
      data-placed={chrome.placed}
      className={SIDE_TAB_GROUP_COLUMN_CLASS}
      style={{ "--side-tab-group-color": props.color } as CSSProperties}
    >
      {chrome.placed ? (
        <m.div
          aria-hidden
          data-joining={joining}
          data-testid="side-tab-group-fill"
          className={cn(SIDE_TAB_GROUP_FILL_LAYER_CLASS, "rounded-3xl")}
          style={{
            y: chrome.offset,
            bottom: chrome.reach,
            opacity: hidden,
          }}
        />
      ) : null}
      {props.dropEdge === null ? null : (
        <SideTabGroupDropEdge edge={props.dropEdge} variant="collapsed" />
      )}
      {props.header === null ? null : (
        <m.div
          className="relative"
          style={{ y: chrome.offset, opacity: hidden }}
        >
          {props.header}
        </m.div>
      )}
      {props.children}
    </div>
  );
}
