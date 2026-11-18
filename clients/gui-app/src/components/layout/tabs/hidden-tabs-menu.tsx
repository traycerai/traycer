import { useRef, useState, type RefObject } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import type { HeaderTab } from "@/stores/tabs/types";
import { tabAppearance } from "@/stores/tabs/types";
import { tabRefKey } from "@/stores/tabs/layout";
import { useHeaderTabAppearance } from "@/hooks/appearance/use-header-tab-appearance";
import { useHeaderTabTitle } from "./header-tab-presentation";

interface HiddenTabsMenuProps {
  readonly tabs: ReadonlyArray<HeaderTab>;
  readonly side: "left" | "right";
  readonly onActivate: (tab: HeaderTab) => void;
  readonly fallbackFocusRef: RefObject<HTMLElement | null>;
}

export function HiddenTabsMenu(props: HiddenTabsMenuProps) {
  return (
    <div
      data-hidden-tabs-control={props.side}
      className="flex w-9 shrink-0 items-center justify-center self-center"
    >
      {props.tabs.length > 0 ? <HiddenTabsPopover {...props} /> : null}
    </div>
  );
}

function HiddenTabsPopover(props: HiddenTabsMenuProps) {
  const [open, setOpen] = useState(false);
  const activatedTab = useRef(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const label = `Tabs hidden to the ${props.side}`;
  const align = props.side === "left" ? "start" : "end";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <TooltipWrapper
          label={label}
          side="bottom"
          sideOffset={4}
          align={align}
        >
          <Button
            ref={triggerRef}
            type="button"
            variant="muted"
            size="icon-sm"
            aria-label={label}
            className="[-webkit-app-region:no-drag]"
          >
            <ChevronDown className="size-3.5" aria-hidden />
          </Button>
        </TooltipWrapper>
      </PopoverTrigger>
      <PopoverContent
        align={align}
        layout="panel"
        className="w-[min(90vw,20rem)]"
        onCloseAutoFocus={(event) => {
          if (activatedTab.current) {
            event.preventDefault();
          } else if (triggerRef.current === null) {
            // Scrolling or resizing can remove this edge's trigger while its
            // search field has focus. Keep focus in the strip without undoing
            // the scroll or stealing focus from an outside interaction.
            event.preventDefault();
            if (document.activeElement === document.body) {
              props.fallbackFocusRef.current?.focus({ preventScroll: true });
            }
          }
          activatedTab.current = false;
        }}
      >
        <Command variant="embedded" selection="flat" label="Search hidden tabs">
          <CommandInput
            placeholder="Search hidden tabs…"
            aria-label="Search hidden tabs"
          />
          <CommandList>
            <CommandEmpty>No matching tabs.</CommandEmpty>
            <CommandGroup heading={label}>
              {props.tabs.map((tab) => (
                <HiddenTabMenuItem
                  key={tabRefKey(tab)}
                  tab={tab}
                  onActivate={() => {
                    activatedTab.current = true;
                    setOpen(false);
                    props.onActivate(tab);
                  }}
                />
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function HiddenTabMenuItem(props: {
  readonly tab: HeaderTab;
  readonly onActivate: () => void;
}) {
  const { displayName } = useHeaderTabTitle(props.tab);
  const tab = useHeaderTabAppearance(props.tab) ?? props.tab;
  const Icon = tab.icon;
  const customIcon = tabAppearance(tab)?.icon;
  let icon = Icon === null ? null : <Icon className="size-4" />;
  if (customIcon) icon = <span className="shrink-0">{customIcon}</span>;
  return (
    <CommandItem
      value={tabRefKey(props.tab)}
      keywords={[displayName]}
      onSelect={props.onActivate}
    >
      <span
        aria-hidden
        className="flex size-8 shrink-0 items-center justify-center rounded-md bg-foreground/8"
      >
        {icon}
      </span>
      <TooltipWrapper
        label={displayName}
        side="right"
        sideOffset={4}
        align="start"
      >
        <span className="min-w-0 flex-1 truncate">{displayName}</span>
      </TooltipWrapper>
    </CommandItem>
  );
}
