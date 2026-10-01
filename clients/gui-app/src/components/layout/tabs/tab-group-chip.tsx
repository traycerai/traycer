import type { CSSProperties } from "react";
import { useRef } from "react";
import { ChevronRight } from "lucide-react";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useTabsStore } from "@/stores/tabs/store";
import type { TabGroup } from "@/stores/tabs/tab-groups";
import { GroupEditorAnchor } from "./group-editor-anchor";
import { cn } from "@/lib/utils";
import { stripGroupMarkKey } from "@/stores/tabs/strip-motion";
import { useStripEntrance } from "./use-strip-entrance";

export function TabGroupChip(props: {
  readonly groupId: string;
  readonly group: TabGroup;
  readonly onClose: (groupId: string) => void;
}) {
  const { group, groupId } = props;
  const chipRef = useRef<HTMLButtonElement | null>(null);
  // A group a reopen brings back opens its chip first; its tabs follow.
  useStripEntrance(chipRef, stripGroupMarkKey(groupId), "chip");
  const actions = useTabsStore.getState();
  return (
    <GroupEditorAnchor groupId={groupId} group={group} onClose={props.onClose}>
      <TooltipWrapper
        label="Right-click to edit group"
        side="bottom"
        sideOffset={6}
        align="start"
      >
        <button
          ref={chipRef}
          type="button"
          // A strip member of its own: a closing slot's spacer is placed
          // relative to it (`strip-exit-ghosts.ts`).
          data-strip-group-chip={groupId}
          aria-label={`${group.name || "Unnamed group"}: ${group.collapsed ? "expand" : "collapse"} group`}
          aria-expanded={!group.collapsed}
          className="relative mx-1 flex min-h-6 self-center max-w-48 shrink-0 items-center gap-1 rounded-md bg-[var(--swatch)] px-2 text-ui-xs font-medium text-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [-webkit-app-region:no-drag]"
          style={{ "--swatch": group.color } as CSSProperties}
          onClick={(event) => {
            event.preventDefault();
            actions.updateGroup(groupId, { collapsed: !group.collapsed });
          }}
        >
          <ChevronRight
            aria-hidden
            className={cn(
              "size-3 transition-transform",
              !group.collapsed && "rotate-90",
            )}
          />
          {group.name ? <span className="truncate">{group.name}</span> : null}
        </button>
      </TooltipWrapper>
    </GroupEditorAnchor>
  );
}
