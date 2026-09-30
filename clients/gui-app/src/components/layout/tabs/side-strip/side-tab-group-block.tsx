import { useRef, type CSSProperties, type ReactNode } from "react";
import { useGroupNameColor } from "./group-name-color";
import { SIDE_TAB_GROUP_BLOCK_CLASS } from "./side-strip-tokens";

/**
 * A tab group in the expanded strip: one tinted, rounded block holding the
 * group's header and its rows. The header is the Layered view's
 * (`SideTabGroupHeader`) or the Activity view's label (`SideTabGroupLabel`); its
 * name is lifted to 4.5:1 on the block's own fill. A collapsed group, in the
 * Layered view, is the header alone.
 */
export function SideTabGroupBlock(props: {
  readonly groupId: string;
  readonly color: string;
  /** The Layered view's fold state; `null` in the Activity view, which has none. */
  readonly collapsed: boolean | null;
  readonly header: ReactNode;
  readonly children: ReactNode;
}): ReactNode {
  const blockRef = useRef<HTMLDivElement | null>(null);
  useGroupNameColor(blockRef, props.color);
  return (
    <div
      ref={blockRef}
      data-testid={`side-tab-group-block-${props.groupId}`}
      data-collapsed={props.collapsed ?? undefined}
      className={SIDE_TAB_GROUP_BLOCK_CLASS}
      style={{ "--side-tab-group-color": props.color } as CSSProperties}
    >
      {props.header}
      {props.children}
    </div>
  );
}
