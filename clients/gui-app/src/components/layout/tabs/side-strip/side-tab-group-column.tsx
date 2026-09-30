import type { CSSProperties, ReactNode } from "react";
import { SIDE_TAB_GROUP_COLUMN_CLASS } from "./side-strip-tokens";

/**
 * A tab group in the collapsed rail: one tinted, rounded column around its
 * tiles (the group's header tile first in the Layered view). It carries the
 * group's colour, so the tiles in it draw no ring of their own.
 */
export function SideTabGroupColumn(props: {
  readonly groupId: string;
  readonly color: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <div
      data-testid={`side-tab-group-column-${props.groupId}`}
      className={SIDE_TAB_GROUP_COLUMN_CLASS}
      style={{ "--side-tab-group-color": props.color } as CSSProperties}
    >
      {props.children}
    </div>
  );
}
