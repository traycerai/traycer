import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { TabGroup } from "@/stores/tabs/tab-groups";
import { GroupEditorAnchor } from "../group-editor-anchor";
import {
  SIDE_TAB_GROUP_LABEL_CLASS,
  SIDE_TAB_GROUP_NAME_CLASS,
} from "./side-strip-tokens";

/**
 * A group block's header in the Activity view: its name, and the group's
 * editor on a right-click, F2 or the context-menu keys, as on the Layered
 * view's header, and on Enter or Space, since the label has no action of its
 * own. The sections do the folding there, so a group has no fold of its own
 * and no count to show, and a pointer click does nothing.
 */
export function SideTabGroupLabel(props: {
  readonly groupId: string;
  readonly group: TabGroup;
  readonly onClose: (groupId: string) => void;
}): ReactNode {
  const { groupId, group } = props;
  return (
    <GroupEditorAnchor
      groupId={groupId}
      group={group}
      onClose={props.onClose}
      opensOnEnter
    >
      <button
        type="button"
        aria-label={`${group.name || "Unnamed group"}: edit group`}
        aria-haspopup="dialog"
        data-testid={`side-tab-group-label-${groupId}`}
        className={cn(
          SIDE_TAB_GROUP_LABEL_CLASS,
          "w-full rounded-lg text-start outline-none focus-visible:ring-3 focus-visible:ring-ring/50 [-webkit-app-region:no-drag]",
        )}
      >
        {group.name ? (
          <span
            data-testid="side-tab-group-name"
            className={cn(SIDE_TAB_GROUP_NAME_CLASS, "min-w-0 truncate")}
          >
            {group.name}
          </span>
        ) : null}
      </button>
    </GroupEditorAnchor>
  );
}
