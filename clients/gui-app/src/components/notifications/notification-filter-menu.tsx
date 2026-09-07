import type { ReactNode } from "react";
import { ListFilter } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { cn } from "@/lib/utils";
import {
  ALL_NOTIFICATION_CATEGORIES,
  type NotificationCategory,
} from "@/lib/notifications/notification-category";

// A `Record` gives every category exactly one label, and TypeScript rejects the object if a category is ever
// added without one.
const CATEGORY_LABEL: Readonly<Record<NotificationCategory, string>> = {
  task: "Task activity",
  collaboration: "Collaboration",
  system: "System issues",
};

interface NotificationFilterMenuProps {
  readonly unreadOnly: boolean;
  readonly categories: ReadonlySet<NotificationCategory>;
  readonly onUnreadOnlyChange: (next: boolean) => void;
  readonly onToggleCategory: (category: NotificationCategory) => void;
  /** Fires on every Radix-driven open/close transition, including the menu's own outside-pointerdown
   * self-dismissal - never on a call the ancestor Popover's guard makes itself. */
  readonly onOpenChange: (open: boolean) => void;
  /** Reports the physical pointer location before the modal menu releases
   * its body lock, while the ancestor popover is still pointer-disabled. */
  readonly onPointerDownOutside: (point: {
    readonly clientX: number;
    readonly clientY: number;
  }) => void;
}

/** Recent-activity-only filter menu: an independent Unread-only toggle plus multi-select source categories.
 * Never affects Attention. */
export function NotificationFilterMenu(
  props: NotificationFilterMenuProps,
): ReactNode {
  const isDefault =
    !props.unreadOnly &&
    props.categories.size === ALL_NOTIFICATION_CATEGORIES.size;

  return (
    <DropdownMenu onOpenChange={props.onOpenChange}>
      <TooltipWrapper label="Filter" side="bottom" sideOffset={6} align="end">
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            data-testid="notifications-filter-trigger"
            aria-label="Filter notifications"
            className={cn(
              "relative text-muted-foreground hover:text-foreground",
              !isDefault && "text-foreground",
            )}
          >
            <ListFilter className="size-3.5" aria-hidden />
            {!isDefault && (
              <span
                aria-hidden
                data-testid="notifications-filter-active-dot"
                className="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-primary"
              />
            )}
          </Button>
        </DropdownMenuTrigger>
      </TooltipWrapper>
      <DropdownMenuContent
        align="end"
        data-testid="notifications-filter-menu"
        className="w-52"
        onPointerDownOutside={(event) => {
          const { clientX, clientY } = event.detail.originalEvent;
          props.onPointerDownOutside({ clientX, clientY });
        }}
      >
        <DropdownMenuCheckboxItem
          checked={props.unreadOnly}
          onCheckedChange={props.onUnreadOnlyChange}
          onSelect={(event) => event.preventDefault()}
          data-testid="notifications-filter-unread-only"
        >
          Unread only
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Categories</DropdownMenuLabel>
        {[...ALL_NOTIFICATION_CATEGORIES].map((category) => (
          <DropdownMenuCheckboxItem
            key={category}
            checked={props.categories.has(category)}
            onCheckedChange={() => props.onToggleCategory(category)}
            onSelect={(event) => event.preventDefault()}
            data-testid={`notifications-filter-category-${category}`}
          >
            {CATEGORY_LABEL[category]}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
