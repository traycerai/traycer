import type { ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export interface DiffLoadingSkeletonProps {
  readonly variant: "panel" | "capability";
}

const VARIANT_CONFIG = {
  panel: {
    headerClassName: "h-6 w-32",
    rowIds: ["row-1", "row-2", "row-3", "row-4", "row-5"],
    rowSpacingClassName: "mt-4",
  },
  capability: {
    headerClassName: "h-6 w-40",
    rowIds: ["row-1", "row-2", "row-3"],
    rowSpacingClassName: "mt-3",
  },
} as const;

export function DiffLoadingSkeleton(
  props: DiffLoadingSkeletonProps,
): ReactNode {
  const config = VARIANT_CONFIG[props.variant];

  return (
    <div
      className="flex min-h-0 flex-1 flex-col items-stretch bg-background p-4"
      data-testid="diff-loading-skeleton"
    >
      <Skeleton className={config.headerClassName} />
      <div className={cn("space-y-2", config.rowSpacingClassName)}>
        {config.rowIds.map((rowId) => (
          <Skeleton
            key={`${props.variant}-${rowId}`}
            className="h-4 w-full rounded"
          />
        ))}
      </div>
    </div>
  );
}
