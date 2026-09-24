import { TaskAppearancePicker } from "./task-appearance-picker";
import type { HistoryItem } from "@/components/home/data/home-page.data";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import {
  Check,
  Group,
  Palette,
  Plus,
  Tag,
  Ungroup,
  MoreHorizontal,
} from "lucide-react";
import {
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import { useOrganization } from "@/hooks/organization/organization-context";
import { OrganizationDot } from "./organization-metadata";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";

export function TaskOrganizationMenu(props: {
  readonly taskId: string;
  readonly canEdit: boolean;
  readonly title: string | undefined;
  readonly dropdown?: boolean;
}) {
  const MenuItem = props.dropdown ? DropdownMenuItem : ContextMenuItem;
  const MenuSeparator = props.dropdown
    ? DropdownMenuSeparator
    : ContextMenuSeparator;
  const MenuSub = props.dropdown ? DropdownMenuSub : ContextMenuSub;
  const MenuSubContent = props.dropdown
    ? DropdownMenuSubContent
    : ContextMenuSubContent;
  const MenuSubTrigger = props.dropdown
    ? DropdownMenuSubTrigger
    : ContextMenuSubTrigger;
  const organization = useOrganization();
  if (!organization?.supported) return null;
  const view = organization.view;
  const groupId = view?.groups.memberships.find(
    (m) => m.taskId === props.taskId,
  )?.groupId;
  return (
    <>
      <MenuItem
        onSelect={() =>
          organization.openDialog({
            kind: "labels",
            taskId: props.taskId,
            canEdit: props.canEdit,
          })
        }
      >
        <Tag />
        Labels
      </MenuItem>
      <MenuSub>
        <MenuSubTrigger
          onPointerLeave={(event) => {
            // A form keeps focus while the pointer crosses from its launcher.
            // Radix's normal row-leave behavior focuses the parent menu and
            // can dismiss the submenu before the field receives the click.
            if (event.currentTarget.getAttribute("aria-expanded") === "true")
              event.preventDefault();
          }}
        >
          <Palette />
          Task appearance
        </MenuSubTrigger>
        <MenuSubContent
          layout="panel"
          className="w-[var(--radix-popper-available-width)] min-w-0 max-w-xs max-h-[var(--radix-popper-available-height)] overflow-y-auto"
          onFocus={(event) => {
            if (event.target === event.currentTarget)
              event.currentTarget.querySelector("input")?.focus();
          }}
        >
          <TaskAppearancePicker taskId={props.taskId} />
        </MenuSubContent>
      </MenuSub>
      <MenuSub>
        <MenuSubTrigger>
          <Group />
          {groupId ? "Move to group" : "Add to group"}
        </MenuSubTrigger>
        <MenuSubContent>
          <MenuItem
            onSelect={() =>
              organization.openDialog({
                kind: "new-group",
                taskId: props.taskId,
              })
            }
          >
            <Plus />
            New group…
          </MenuItem>
          {view?.groups.groups.length ? <MenuSeparator /> : null}
          {view?.groups.groups.map((group) => (
            <MenuItem
              key={group.groupId}
              disabled={
                !view.appearances.some((a) => a.taskId === props.taskId)
              }
              onSelect={() => {
                const canvas = useEpicCanvasStore.getState();
                const openTasks = new Set(
                  canvas.openTabOrder.flatMap((id) => {
                    const tab = canvas.tabsById[id];
                    return tab ? [tab.epicId] : [];
                  }),
                );
                const isOpen = view.groups.memberships.some(
                  (m) => m.groupId === group.groupId && openTasks.has(m.taskId),
                );
                void organization
                  .command({
                    kind: "groups",
                    operations: [
                      {
                        operation: "moveTask",
                        taskId: props.taskId,
                        groupId: group.groupId,
                        position: view.groups.memberships.filter(
                          (m) => m.groupId === group.groupId,
                        ).length,
                      },
                    ],
                  })
                  .then(() => {
                    if (isOpen || openTasks.has(props.taskId)) {
                      for (const member of view.groups.memberships.filter(
                        (m) => m.groupId === group.groupId,
                      ))
                        useEpicCanvasStore
                          .getState()
                          .openEpicTabInBackground(member.taskId, undefined);
                      useEpicCanvasStore
                        .getState()
                        .openEpicTabInBackground(props.taskId, props.title);
                    }
                  })
                  .catch(() => undefined);
              }}
            >
              <OrganizationDot color={group.color} />
              <span className="max-w-48 truncate">{group.name}</span>
              {groupId === group.groupId ? <Check className="ml-auto" /> : null}
            </MenuItem>
          ))}
        </MenuSubContent>
      </MenuSub>
      {groupId ? (
        <MenuItem
          onSelect={() => {
            void organization
              .command({
                kind: "groups",
                operations: [{ operation: "removeTask", taskId: props.taskId }],
              })
              .catch(() => undefined);
          }}
        >
          <Ungroup />
          Remove from group
        </MenuItem>
      ) : null}
      <MenuSeparator />
    </>
  );
}

export function TaskOrganizationDropdown(props: {
  readonly taskId: string;
  readonly canEdit: boolean;
  readonly title: string;
}) {
  const organization = useOrganization();
  if (!organization?.supported) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Organize ${props.title}`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <TaskOrganizationMenu {...props} dropdown />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function HistoryTaskOrganizationMenu({
  item,
  canEdit,
}: {
  readonly item: HistoryItem;
  readonly canEdit: boolean;
}) {
  if (item.taskType === "phase" || item.isLocalHome || item.isPreservedOrphan)
    return null;
  return (
    <TaskOrganizationMenu
      taskId={item.epicId}
      canEdit={canEdit}
      title={item.title}
    />
  );
}

export function HistoryOrganizationDropdown({
  item,
  canEdit,
}: {
  readonly item: HistoryItem;
  readonly canEdit: boolean;
}) {
  if (item.taskType === "phase" || item.isLocalHome || item.isPreservedOrphan)
    return null;
  return (
    <TaskOrganizationDropdown
      taskId={item.epicId}
      canEdit={canEdit}
      title={item.title}
    />
  );
}
