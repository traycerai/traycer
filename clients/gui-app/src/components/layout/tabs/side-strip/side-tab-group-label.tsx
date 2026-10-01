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
 * view's header. The sections do the folding there, so a group has no fold of
 * its own and no count to show, and a click does nothing.
 */
export function SideTabGroupLabel(props: {
  readonly groupId: string;
  readonly group: TabGroup;
  readonly onClose: (groupId: string) => void;
}): ReactNode {
  const { groupId, group } = props;
  return (
    <GroupEditorAnchor groupId={groupId} group={group} onClose={props.onClose}>
      <div
        role="button"
        tabIndex={0}
        aria-label={`${group.name || "Unnamed group"}: group`}
        aria-haspopup="dialog"
        aria-keyshortcuts="F2"
        data-testid={`side-tab-group-label-${groupId}`}
        className={cn(
          SIDE_TAB_GROUP_LABEL_CLASS,
          "rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/50 [-webkit-app-region:no-drag]",
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
      </div>
    </GroupEditorAnchor>
  );
}
