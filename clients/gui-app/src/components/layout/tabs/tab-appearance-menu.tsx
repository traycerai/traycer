import { useOrganization } from "@/hooks/organization/organization-context";
import { TaskOrganizationMenu } from "@/components/organization/task-organization-menu";
import { useEpicGetTaskContexts } from "@/hooks/epic/use-epic-get-task-contexts-query";
import { isEditableRole } from "@/lib/epic-permissions";
import { Label } from "@/components/ui/label";
import type { CSSProperties } from "react";
import { useId } from "react";
import { Check, Group, Palette, Pipette } from "lucide-react";
import {
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { Input } from "@/components/ui/input";
import { useTabsStore } from "@/stores/tabs/store";
import { tabRefKey } from "@/stores/tabs/layout";
import { TAB_COLORS } from "@/stores/tabs/tab-groups";
import type { HeaderTab } from "@/stores/tabs/types";
import { cn } from "@/lib/utils";

export function TabColorPicker(props: {
  readonly menu: boolean;
  readonly color: string | null;
  readonly onChange: (color: string) => void;
  readonly onDefault?: () => void;
}) {
  const customColorId = useId();
  const selectedColor = props.color?.toLowerCase() ?? null;
  const customColor =
    selectedColor !== null &&
    !TAB_COLORS.some(({ value }) => value === selectedColor);
  const customInput = (
    <input
      id={customColorId}
      type="color"
      aria-label="Custom tab color"
      value={props.color ?? TAB_COLORS[1].value}
      onChange={(event) => props.onChange(event.currentTarget.value)}
      className="absolute inset-0 size-full min-w-0 cursor-pointer appearance-none rounded-full border-0 p-0 opacity-0"
    />
  );
  return (
    <div role="group" aria-label="Color" className="flex flex-wrap gap-1 p-1">
      {props.onDefault ? (
        <button
          type="button"
          aria-label="Default"
          aria-pressed={selectedColor === null}
          onClick={props.onDefault}
          className={cn(
            "flex size-6 items-center justify-center rounded-full border border-input bg-popover text-foreground ring-offset-2 ring-offset-popover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            selectedColor === null && "ring-2 ring-ring",
          )}
        >
          {selectedColor === null ? (
            <Check className="size-3.5" aria-hidden />
          ) : (
            <span
              className="size-3 rounded-full border border-current"
              aria-hidden
            />
          )}
        </button>
      ) : null}
      {TAB_COLORS.map(({ name, value }) => {
        const button = (
          <button
            key={value}
            type="button"
            aria-label={name}
            role={props.menu ? "menuitemradio" : undefined}
            aria-checked={props.menu ? selectedColor === value : undefined}
            aria-pressed={props.menu ? undefined : selectedColor === value}
            onClick={() => props.onChange(value)}
            className={cn(
              "flex size-6 items-center justify-center rounded-full bg-[var(--swatch)] text-black ring-offset-2 ring-offset-popover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              selectedColor === value && "ring-2",
            )}
            style={{ "--swatch": value } as CSSProperties}
          >
            {selectedColor === value ? (
              <Check className="size-3.5" aria-hidden />
            ) : null}
          </button>
        );
        return props.menu ? (
          <ContextMenuItem
            key={value}
            asChild
            onSelect={(event) => event.preventDefault()}
          >
            {button}
          </ContextMenuItem>
        ) : (
          button
        );
      })}
      <TooltipWrapper
        label="Custom color"
        side="top"
        sideOffset={6}
        align="center"
      >
        <label
          htmlFor={customColorId}
          className={cn(
            "relative flex size-6 shrink-0 items-center justify-center rounded-full focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 focus-within:ring-offset-popover",
            customColor
              ? "bg-[var(--swatch)]"
              : "bg-[conic-gradient(#e5484d,#f5b000,#46a758,#0090ff,#7c6cf0,#e5484d)]",
          )}
          style={
            customColor
              ? ({ "--swatch": selectedColor } as CSSProperties)
              : undefined
          }
        >
          <Pipette className="size-3 text-white drop-shadow-sm" aria-hidden />
          {props.menu ? (
            <ContextMenuItem
              asChild
              className="absolute inset-0 size-full p-0"
              onSelect={(event) => event.preventDefault()}
            >
              {customInput}
            </ContextMenuItem>
          ) : (
            customInput
          )}
        </label>
      </TooltipWrapper>
    </div>
  );
}

export function TabAppearanceMenu(props: { readonly tab: HeaderTab }) {
  if (props.tab.kind !== "epic") return null;
  return <EpicOrganizationMenu tab={props.tab} />;
}
function EpicOrganizationMenu(props: {
  readonly tab: Extract<HeaderTab, { kind: "epic" }>;
}) {
  const organization = useOrganization();
  const contexts = useEpicGetTaskContexts(
    [props.tab.epicId],
    organization?.userId ?? null,
    { enabled: organization?.supported ?? false },
  );
  const task = contexts.tasksById.get(props.tab.epicId);
  if (
    organization?.supported &&
    !contexts.localHomedTaskIds.has(props.tab.epicId)
  ) {
    if (task?.epic === undefined || task.epic === null) return null;
    return (
      <TaskOrganizationMenu
        taskId={props.tab.epicId}
        title={props.tab.name}
        canEdit={
          task.epic.light?.createdBy === organization.userId ||
          isEditableRole(task.epic.permission?.role ?? null)
        }
      />
    );
  }
  return <LocalTabAppearanceMenu tab={props.tab} />;
}
function LocalTabAppearanceMenu(props: { readonly tab: HeaderTab }) {
  const key = tabRefKey(props.tab);
  const customization = useTabsStore((state) => state.customizations?.[key]);
  const groups = useTabsStore((state) => state.groups);
  const groupId = customization?.groupId ?? null;
  const actions = useTabsStore.getState();
  return (
    <>
      <ContextMenuSub>
        <ContextMenuSubTrigger>
          <Palette />
          Tab appearance
        </ContextMenuSubTrigger>
        <ContextMenuSubContent layout="panel" className="max-w-xs">
          <TabColorPicker
            menu
            color={customization?.color ?? null}
            onChange={(color) => {
              actions.setTabCustomization(props.tab, { color });
            }}
          />
          <Label className="mt-3 mb-1.5">Icon</Label>
          <Input
            aria-label="Tab icon"
            placeholder="Emoji or initials"
            maxLength={32}
            value={customization?.icon ?? ""}
            onKeyDown={(event) => {
              if (event.key !== "Escape") event.stopPropagation();
            }}
            onChange={(event) =>
              actions.setTabCustomization(props.tab, {
                icon: event.target.value || null,
              })
            }
          />
          <p className="mt-1 text-ui-xs text-muted-foreground">
            Displays up to two characters.
          </p>
          {customization?.color || customization?.icon ? (
            <>
              <ContextMenuSeparator className="my-2" />
              <ContextMenuItem
                onSelect={() =>
                  actions.setTabCustomization(props.tab, {
                    color: null,
                    icon: null,
                  })
                }
              >
                Reset tab appearance
              </ContextMenuItem>
            </>
          ) : null}
        </ContextMenuSubContent>
      </ContextMenuSub>
      <ContextMenuSub>
        <ContextMenuSubTrigger>
          <Group />
          Add tab to group
        </ContextMenuSubTrigger>
        <ContextMenuSubContent>
          <ContextMenuItem onSelect={() => actions.createGroup(props.tab)}>
            New group
          </ContextMenuItem>
          {Object.entries(groups ?? {})
            .filter(([, entry]) => !entry.organizationOwnerId)
            .map(([id, entry]) => (
              <ContextMenuItem
                key={id}
                onSelect={() => actions.setTabGroup(props.tab, id)}
              >
                <span
                  className="size-3 rounded-full bg-[var(--swatch)]"
                  style={{ "--swatch": entry.color } as CSSProperties}
                />
                {entry.name || "Unnamed group"}
                {id === groupId ? <Check className="ml-auto" /> : null}
              </ContextMenuItem>
            ))}
        </ContextMenuSubContent>
      </ContextMenuSub>
      {groupId !== null ? (
        <ContextMenuItem onSelect={() => actions.setTabGroup(props.tab, null)}>
          Remove from group
        </ContextMenuItem>
      ) : null}
      <ContextMenuSeparator />
    </>
  );
}
