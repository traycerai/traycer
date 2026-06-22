import {
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
} from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

const ROWS: ReadonlyArray<{
  readonly id: string;
  readonly labelWidth: string;
}> = [
  { id: "a", labelWidth: "w-2/3" },
  { id: "b", labelWidth: "w-1/2" },
  { id: "c", labelWidth: "w-3/5" },
];

export function TerminalsPanelSkeleton() {
  return (
    <SidebarContent
      className="min-h-0"
      data-testid="terminals-panel-skeleton"
      aria-busy="true"
    >
      <SidebarGroup className="flex-1 px-2 py-3">
        <SidebarGroupContent className="space-y-0.5">
          {ROWS.map((row) => (
            <div
              key={row.id}
              className="flex h-9 items-center gap-1.5 rounded-md px-2"
            >
              <Skeleton className="size-3.5 shrink-0 rounded-sm" />
              <Skeleton className={cn("h-3 rounded", row.labelWidth)} />
            </div>
          ))}
        </SidebarGroupContent>
      </SidebarGroup>
    </SidebarContent>
  );
}
