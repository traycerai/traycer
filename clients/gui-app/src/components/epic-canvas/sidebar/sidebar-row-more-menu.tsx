import { MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SidebarDropdownMenuItems,
  type SidebarRowMenuEntry,
} from "@/components/epic-canvas/sidebar/sidebar-row-menu-items";
import { useSidebarRowDropdownMount } from "@/components/epic-canvas/sidebar/use-sidebar-row-dropdown-mount";

/** Keep an untouched row's trigger accessible without mounting a Radix root. */
export function SidebarRowMoreMenu(props: {
  readonly nodeId: string;
  readonly label: string;
  readonly className: string;
  readonly entries: ReadonlyArray<SidebarRowMenuEntry>;
}) {
  const dropdown = useSidebarRowDropdownMount();
  const trigger = (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      id={dropdown.triggerId}
      aria-label={props.label}
      aria-haspopup="menu"
      aria-expanded={dropdown.open}
      data-state={dropdown.open ? "open" : "closed"}
      data-slot="dropdown-menu-trigger"
      data-testid={`epic-sidebar-more-${props.nodeId}`}
      className={props.className}
      onPointerDown={dropdown.onPointerDown}
      onKeyDown={dropdown.onKeyDown}
      onClick={(event) => {
        event.stopPropagation();
        dropdown.onClick();
      }}
    >
      <MoreHorizontal className="size-3" />
    </Button>
  );

  if (!dropdown.mounted) return trigger;
  return (
    <DropdownMenu open={dropdown.open} onOpenChange={dropdown.setOpen}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-max">
        <SidebarDropdownMenuItems entries={props.entries} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
