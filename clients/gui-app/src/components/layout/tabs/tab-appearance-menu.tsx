import { useId, useRef } from "react";
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
              "flex size-6 items-center justify-center rounded-full ring-offset-2 ring-offset-popover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              selectedColor === value && "ring-2",
            )}
            style={{ backgroundColor: value, color: "#202124" }}
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
          className="relative flex size-6 shrink-0 items-center justify-center rounded-full focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 focus-within:ring-offset-popover"
          style={
            customColor
              ? { backgroundColor: selectedColor }
              : {
                  backgroundImage:
                    "conic-gradient(#e5484d, #f5b000, #46a758, #0090ff, #7c6cf0, #e5484d)",
                }
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
  const iconInput = useRef<HTMLInputElement>(null);
  const key = tabRefKey(props.tab);
  const customization = useTabsStore((state) => state.customizations?.[key]);
  const groups = useTabsStore((state) => state.groups);
  const groupId = customization?.groupId ?? null;
  const group = groupId === null ? undefined : groups?.[groupId];
  const actions = useTabsStore.getState();
  return (
    <>
      <ContextMenuSub>
        <ContextMenuSubTrigger>
          <Palette />
          Tab appearance
        </ContextMenuSubTrigger>
        <ContextMenuSubContent className="max-w-xs p-3">
          <TabColorPicker
            menu
            color={group?.color ?? customization?.color ?? null}
            onChange={(color) => {
              if (groupId !== null) actions.updateGroup(groupId, { color });
              else actions.setTabCustomization(props.tab, { color });
            }}
          />
          {group !== undefined ? (
            <p className="mt-2 text-ui-xs text-muted-foreground">
              Color applies to this group.
            </p>
          ) : null}
          <ContextMenuItem
            className="mt-2"
            onSelect={(event) => {
              event.preventDefault();
              iconInput.current?.focus();
            }}
          >
            Edit icon…
          </ContextMenuItem>
          <Input
            ref={iconInput}
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
          {Object.entries(groups ?? {}).map(([id, entry]) => (
            <ContextMenuItem
              key={id}
              onSelect={() => actions.setTabGroup(props.tab, id)}
            >
              <span
                className="size-3 rounded-full"
                style={{ backgroundColor: entry.color }}
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
