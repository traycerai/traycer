import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface SidebarPanelEmptyStateProps {
  readonly icon: LucideIcon;
  readonly title: string;
  readonly description: string | null;
  readonly testId: string | undefined;
}

export function SidebarPanelEmptyState(props: SidebarPanelEmptyStateProps) {
  const Icon = props.icon;
  return (
    <div
      className={cn(
        "flex h-full min-h-0 flex-1 flex-col items-center justify-center gap-2 text-center",
        "px-4 py-8 text-muted-foreground",
      )}
      data-testid={props.testId}
    >
      <Icon className="size-8 text-muted-foreground/45" aria-hidden />
      <div className="space-y-1">
        <p className="text-ui-sm text-muted-foreground/60">{props.title}</p>
        {props.description === null ? null : (
          <p className="text-ui-xs text-muted-foreground/50">
            {props.description}
          </p>
        )}
      </div>
    </div>
  );
}
