import { useState } from "react";
import { ChevronRight, Plus, Ungroup, X } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useTabsStore } from "@/stores/tabs/store";
import type { TabGroup } from "@/stores/tabs/tab-groups";
import { TabColorPicker } from "./tab-appearance-menu";
import { navigateToTabIntent } from "@/lib/tab-navigation";
import { openNewEpicIntent } from "@/lib/commands/actions/new-epic";
import { cn } from "@/lib/utils";

export function TabGroupChip(props: {
  readonly groupId: string;
  readonly group: TabGroup;
  readonly onClose: (groupId: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const navigate = useNavigate();
  const { group, groupId } = props;
  const actions = useTabsStore.getState();
  return (
    <Popover open={editing} onOpenChange={setEditing}>
      <PopoverTrigger asChild>
        <TooltipWrapper
          label="Right-click to edit group"
          side="bottom"
          sideOffset={6}
          align="start"
        >
          <button
            type="button"
            aria-label={`${group.name || "Unnamed group"}: ${group.collapsed ? "expand" : "collapse"} group`}
            aria-expanded={!group.collapsed}
            className="relative mx-1 mb-2 flex min-h-6 max-w-48 shrink-0 items-center gap-1 rounded-md px-2 text-ui-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [-webkit-app-region:no-drag]"
            style={{ backgroundColor: group.color, color: "#202124" }}
            onClick={(event) => {
              event.preventDefault();
              actions.updateGroup(groupId, { collapsed: !group.collapsed });
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              setEditing(true);
            }}
            onKeyDown={(event) => {
              if (
                event.key === "F2" ||
                event.key === "ContextMenu" ||
                (event.shiftKey && event.key === "F10")
              ) {
                event.preventDefault();
                setEditing(true);
              }
            }}
          >
            {!group.collapsed ? (
              <span
                aria-hidden
                className="pointer-events-none absolute inset-x-0 -bottom-2 h-0.5"
                style={{ backgroundColor: group.color }}
              />
            ) : null}
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
      </PopoverTrigger>
      <PopoverContent align="start" className="w-fit max-w-xs space-y-3 p-3">
        <Input
          aria-label="Group name"
          placeholder="Name this group"
          maxLength={80}
          value={group.name}
          onChange={(event) =>
            actions.updateGroup(groupId, { name: event.target.value })
          }
          onKeyDown={(event) => {
            if (event.key === "Enter") setEditing(false);
          }}
        />
        <TabColorPicker
          menu={false}
          color={group.color}
          onChange={(color) => actions.updateGroup(groupId, { color })}
        />
        <div className="flex flex-col border-t pt-2">
          <Button
            variant="ghost"
            className="justify-start"
            onClick={() => {
              setEditing(false);
              navigateToTabIntent(
                navigate,
                { ...openNewEpicIntent(), groupId },
                undefined,
              );
            }}
          >
            <Plus />
            New tab in group
          </Button>
          <Button
            variant="ghost"
            className="justify-start"
            onClick={() => {
              setEditing(false);
              props.onClose(groupId);
            }}
          >
            <X />
            Close group
          </Button>
          <Button
            variant="ghost"
            className="justify-start"
            onClick={() => {
              setEditing(false);
              actions.ungroup(groupId);
            }}
          >
            <Ungroup />
            Ungroup
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
