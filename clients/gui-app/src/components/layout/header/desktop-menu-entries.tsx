import type { ReactNode } from "react";
import { CheckIcon, ChevronRightIcon, CircleIcon } from "lucide-react";
import {
  MenubarItem,
  MenubarSeparator,
  MenubarSub,
  MenubarSubContent,
  MenubarSubTrigger,
} from "@/components/ui/menubar";
import type { DesktopMenuEntry } from "@/lib/windows/types";

/** Menu content and commands originate in Electron; this owns presentation only. */
export function DesktopMenuEntries(props: {
  readonly items: readonly DesktopMenuEntry[];
  readonly onSelect: (itemId: string) => void;
}): ReactNode {
  return props.items.map((item) => {
    if (item.type === "separator") return <MenubarSeparator key={item.id} />;
    const label = (
      <>
        <span
          className="flex size-3 shrink-0 items-center justify-center"
          aria-hidden
        >
          {renderCheck(item)}
        </span>
        <span className="min-w-0 flex-1">{item.label}</span>
        {item.accelerator ? (
          <span className="ml-6 shrink-0 text-ui-xs text-popover-foreground/60">
            {item.accelerator
              .replace(/CommandOrControl|CmdOrCtrl/g, "Ctrl")
              .replace(/Control/g, "Ctrl")
              .replace(/Command/g, "Super")}
          </span>
        ) : null}
      </>
    );
    if (item.type === "submenu")
      return (
        <MenubarSub key={item.id}>
          <MenubarSubTrigger disabled={!item.enabled}>
            {label}
            <ChevronRightIcon className="ml-auto size-3" />
          </MenubarSubTrigger>
          <MenubarSubContent>
            <DesktopMenuEntries
              items={item.children}
              onSelect={props.onSelect}
            />
          </MenubarSubContent>
        </MenubarSub>
      );
    return (
      <MenubarItem
        key={item.id}
        disabled={!item.enabled}
        role={menuItemRole(item.type)}
        aria-checked={
          item.type === "checkbox" || item.type === "radio"
            ? item.checked
            : undefined
        }
        onSelect={() => props.onSelect(item.id)}
      >
        {label}
      </MenubarItem>
    );
  });
}

function renderCheck(item: DesktopMenuEntry): ReactNode {
  if (!item.checked) return null;
  if (item.type === "radio")
    return <CircleIcon className="size-1.5 fill-current" />;
  return <CheckIcon className="size-3" />;
}
function menuItemRole(
  type: DesktopMenuEntry["type"],
): "menuitem" | "menuitemcheckbox" | "menuitemradio" {
  if (type === "checkbox") return "menuitemcheckbox";
  if (type === "radio") return "menuitemradio";
  return "menuitem";
}
