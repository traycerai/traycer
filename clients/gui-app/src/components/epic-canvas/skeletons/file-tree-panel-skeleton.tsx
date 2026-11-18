import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

type SkeletonDepth = 0 | 1 | 2;

const ROWS: ReadonlyArray<{
  readonly id: string;
  readonly depth: SkeletonDepth;
  readonly width: string;
}> = [
  { id: "a", depth: 0, width: "w-1/3" },
  { id: "b", depth: 1, width: "w-1/2" },
  { id: "c", depth: 2, width: "w-2/5" },
  { id: "d", depth: 2, width: "w-1/3" },
  { id: "e", depth: 1, width: "w-2/5" },
  { id: "f", depth: 0, width: "w-1/4" },
  { id: "g", depth: 1, width: "w-1/3" },
  { id: "h", depth: 0, width: "w-1/4" },
];

const DEPTH_PADDING: Readonly<Record<SkeletonDepth, string>> = {
  0: "ps-2",
  1: "ps-5",
  2: "ps-9",
};

export function FileTreePanelSkeleton() {
  return (
    <div
      className="h-full p-2"
      data-testid="file-tree-panel-skeleton"
      aria-busy="true"
    >
      <div className="space-y-0.5">
        {ROWS.map((row) => (
          <div
            key={row.id}
            className={cn(
              "flex h-7 items-center gap-1.5",
              DEPTH_PADDING[row.depth],
            )}
          >
            <Skeleton className="size-3 shrink-0 rounded-sm" />
            <Skeleton className={cn("h-3 rounded", row.width)} />
          </div>
        ))}
      </div>
    </div>
  );
}
