import { useId, useRef, type CSSProperties, type ReactNode } from "react";
import * as m from "motion/react-m";
import {
  useHeaderStripGroupPlacement,
  useHeaderStripJoinsGroup,
} from "@/components/epic-canvas/dnd/dnd-store";
import { cn } from "@/lib/utils";
import { GroupEditorScope } from "@/stores/tabs/group-editor-store";
import { useGroupChromeMotion } from "../use-group-chrome-motion";
import { useGroupNameColor } from "./group-name-color";
import {
  SIDE_TAB_GROUP_BLOCK_CLASS,
  SIDE_TAB_GROUP_FILL_LAYER_CLASS,
} from "./side-strip-tokens";
import { SideTabGroupDropEdge } from "./side-tab-group-drop-edge";

/**
 * A tab group in the expanded strip: one tinted, rounded block holding the
 * group's header and its rows. The header is the Layered view's
 * (`SideTabGroupHeader`) or the Activity view's label (`SideTabGroupLabel`); its
 * name is lifted to 4.5:1 on the block's own fill. A collapsed group, in the
 * Layered view, is the header alone. The header is the group's editor anchor
 * for the block's rows too (`GroupEditorScope`), so a row's "Edit group…"
 * opens at this block's header.
 *
 * The drag model measures the block as the group's extent. While a drag lays
 * the strip out, the block's box stays where it is, and the fill and the header
 * are drawn where the layout puts them, so the group moves, grows and shrinks
 * with its tabs; while a drop would join the group the fill brightens a step.
 */
export function SideTabGroupBlock(props: {
  readonly groupId: string;
  readonly color: string;
  /** The Layered view's fold state; `null` in the Activity view, which has none. */
  readonly collapsed: boolean | null;
  /** The Activity view's section the block is in, which is also its drag lane. */
  readonly lane: string | null;
  /** The edge a drop's line sits outside of, when the drop lands beside the block. */
  readonly dropEdge: "top" | "bottom" | null;
  readonly header: ReactNode;
  readonly children: ReactNode;
}): ReactNode {
  const blockRef = useRef<HTMLDivElement | null>(null);
  useGroupNameColor(blockRef, props.color);
  const joining = useHeaderStripJoinsGroup(props.groupId);
  const chrome = useGroupChromeMotion(
    useHeaderStripGroupPlacement(props.groupId, props.lane),
  );
  const hidden = chrome.visible ? 1 : 0;
  const scope = useId();
  return (
    <GroupEditorScope value={scope}>
      <div
        ref={blockRef}
        data-testid={`side-tab-group-block-${props.groupId}`}
        data-strip-group-extent={props.groupId}
        data-strip-lane={props.lane ?? undefined}
        data-joining={joining}
        data-placed={chrome.placed}
        data-collapsed={props.collapsed ?? undefined}
        className={SIDE_TAB_GROUP_BLOCK_CLASS}
        style={{ "--side-tab-group-color": props.color } as CSSProperties}
      >
        {chrome.placed ? (
          <m.div
            aria-hidden
            data-joining={joining}
            data-testid="side-tab-group-fill"
            className={cn(SIDE_TAB_GROUP_FILL_LAYER_CLASS, "rounded-xl")}
            style={{
              y: chrome.offset,
              bottom: chrome.reach,
              opacity: hidden,
            }}
          />
        ) : null}
        {props.dropEdge === null ? null : (
          <SideTabGroupDropEdge edge={props.dropEdge} variant="expanded" />
        )}
        <m.div
          className="relative"
          style={{ y: chrome.offset, opacity: hidden }}
        >
          {props.header}
        </m.div>
        {props.children}
      </div>
    </GroupEditorScope>
  );
}
