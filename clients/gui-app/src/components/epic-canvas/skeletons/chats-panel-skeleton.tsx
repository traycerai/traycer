import {
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
} from "@/components/ui/sidebar";
import { SkeletonTreeRow } from "@/components/epic-canvas/skeletons/skeleton-tree-row";

const ROWS: ReadonlyArray<{
  readonly id: string;
  readonly depth: number;
  readonly labelWidth: string;
}> = [
  { id: "a", depth: 0, labelWidth: "w-3/5" },
  { id: "b", depth: 1, labelWidth: "w-2/3" },
  { id: "c", depth: 0, labelWidth: "w-1/2" },
  { id: "d", depth: 1, labelWidth: "w-3/4" },
  { id: "e", depth: 0, labelWidth: "w-2/5" },
];

export function ChatsPanelSkeleton() {
  return (
    <SidebarContent
      className="min-h-0"
      data-testid="chats-panel-skeleton"
      aria-busy="true"
    >
      <SidebarGroup className="p-2">
        <SidebarGroupContent className="space-y-0.5">
          {ROWS.map((row) => (
            <SkeletonTreeRow
              key={row.id}
              depth={row.depth}
              labelWidth={row.labelWidth}
            />
          ))}
        </SidebarGroupContent>
      </SidebarGroup>
    </SidebarContent>
  );
}
