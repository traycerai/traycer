import {
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
} from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";

const ROWS: ReadonlyArray<string> = ["a", "b", "c"];

export function CommentsPanelSkeleton() {
  return (
    <SidebarContent
      className="min-h-0"
      data-testid="comments-panel-skeleton"
      aria-busy="true"
    >
      <SidebarGroup className="p-2">
        <SidebarGroupContent className="space-y-2">
          {ROWS.map((id) => (
            <div
              key={id}
              className="flex flex-col gap-1.5 rounded-md border border-border/40 p-2"
            >
              <Skeleton className="h-3 w-1/2 rounded" />
              <Skeleton className="h-3 w-full rounded" />
              <Skeleton className="size-3/4 rounded" />
            </div>
          ))}
        </SidebarGroupContent>
      </SidebarGroup>
    </SidebarContent>
  );
}
