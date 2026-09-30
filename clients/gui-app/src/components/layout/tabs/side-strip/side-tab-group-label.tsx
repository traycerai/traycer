import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import {
  SIDE_TAB_GROUP_COUNT_CLASS,
  SIDE_TAB_GROUP_LABEL_CLASS,
  SIDE_TAB_GROUP_NAME_CLASS,
} from "./side-strip-tokens";

/**
 * A group block's header in the Activity view: its name and the count of its
 * tasks in this section, as text and nothing to press. The sections do the
 * folding there, so a group has no fold of its own.
 */
export function SideTabGroupLabel(props: {
  readonly groupId: string;
  readonly name: string;
  /** "3", or "1 of 3" when the group has tasks in other sections. */
  readonly count: string;
}): ReactNode {
  return (
    <div
      data-testid={`side-tab-group-label-${props.groupId}`}
      className={SIDE_TAB_GROUP_LABEL_CLASS}
    >
      {props.name ? (
        <span
          data-testid="side-tab-group-name"
          className={cn(SIDE_TAB_GROUP_NAME_CLASS, "min-w-0 truncate")}
        >
          {props.name}
        </span>
      ) : null}
      <span
        data-testid="side-tab-group-count"
        className={cn(
          SIDE_TAB_GROUP_COUNT_CLASS,
          "shrink-0 text-muted-foreground",
        )}
      >
        {props.count}
      </span>
    </div>
  );
}
