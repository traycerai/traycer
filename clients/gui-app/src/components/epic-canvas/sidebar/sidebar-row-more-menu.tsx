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
import { useColumnOverlayPlacement } from "@/components/layout/column-edge-context";

/** Keep an untouched row's trigger accessible without mounting a Radix root. */
export function SidebarRowMoreMenu(props: {
  readonly nodeId: string;
  readonly label: string;
  readonly className: string;
  readonly entries: ReadonlyArray<SidebarRowMenuEntry>;
}) {
  const {
    mounted,
    open,
    setOpen,
    triggerIdProps,
    triggerRef,
    onPointerDown,
    onKeyDown,
    onClick,
  } = useSidebarRowDropdownMount(false);
  const placement = useColumnOverlayPlacement("row");
  const trigger = (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      ref={triggerRef}
      {...triggerIdProps}
      aria-label={props.label}
      aria-haspopup="menu"
      aria-expanded={open}
      data-state={open ? "open" : "closed"}
      data-slot="dropdown-menu-trigger"
      data-testid={`epic-sidebar-more-${props.nodeId}`}
      className={props.className}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      <MoreHorizontal className="size-3" />
    </Button>
  );

  if (!mounted) return trigger;
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent
        side={placement?.side}
        align={placement?.align ?? "end"}
        className="w-max"
      >
        <SidebarDropdownMenuItems entries={props.entries} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
