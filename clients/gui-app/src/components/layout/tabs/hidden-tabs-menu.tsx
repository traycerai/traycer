import { useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
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

export function HiddenTabsMenu(props: {
  readonly tabs: ReadonlyArray<HeaderTab>;
  readonly onActivate: (tab: HeaderTab) => void;
}) {
  const [open, setOpen] = useState(false);
  const activatedTab = useRef(false);
  const count = props.tabs.length;
  if (count === 0) return null;
  const label = `${count} hidden ${count === 1 ? "tab" : "tabs"}`;
  return (
    <div
      data-hidden-tabs-control
      className="flex shrink-0 items-center self-center px-1"
    >
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <TooltipWrapper
            label={label}
            side="bottom"
            sideOffset={4}
            align="start"
          >
            <button
              type="button"
              aria-label={label}
              className="flex h-7 min-w-9 items-center justify-center gap-1 rounded-md border border-border bg-foreground/8 px-1.5 text-ui-xs font-medium tabular-nums text-foreground transition-colors hover:bg-foreground/12 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:border-foreground/40 data-[state=open]:bg-foreground/12 [-webkit-app-region:no-drag]"
            >
              {count}
              <ChevronDown className="size-3" aria-hidden />
            </button>
          </TooltipWrapper>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          layout="panel"
          className="w-[min(90vw,20rem)]"
          onCloseAutoFocus={(event) => {
            if (activatedTab.current) event.preventDefault();
            activatedTab.current = false;
          }}
        >
          <Command
            variant="embedded"
            selection="flat"
            label="Search hidden tabs"
          >
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
    </div>
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
