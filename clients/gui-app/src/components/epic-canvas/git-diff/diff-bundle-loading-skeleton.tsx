import type { ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { DiffContentLoadingSkeleton } from "./diff-content-loading-skeleton";

interface DiffBundleLoadingSkeletonProps {
  readonly mode: "split" | "unified";
}

const BUNDLE_SECTIONS = [
  { id: "bundle-section-1", filenameWidthRem: 7.5 },
  { id: "bundle-section-2", filenameWidthRem: 6.25 },
] as const;

export function DiffBundleLoadingSkeleton(
  props: DiffBundleLoadingSkeletonProps,
): ReactNode {
  return (
    <div
      aria-busy="true"
      aria-label="Loading bundle diff"
      className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-background"
      data-testid="diff-bundle-loading-skeleton"
    >
      {BUNDLE_SECTIONS.map((section, sectionIndex) => (
        <div
          key={section.id}
          className="border-b border-border/70 bg-background"
        >
          <div className="flex items-center gap-1 border-b border-border/60 bg-background p-1">
            <div className="flex min-h-7 min-w-0 flex-1 items-center gap-2 px-2">
              <Skeleton className="size-4 shrink-0 rounded-sm" />
              <Skeleton className="size-4 shrink-0 rounded-full" />
              <Skeleton className="size-3.5 shrink-0 rounded-sm" />
              <Skeleton
                className="h-3 max-w-[min(55%,16rem)] rounded-sm"
                style={{ width: `${section.filenameWidthRem}rem` }}
              />
              <Skeleton className="ml-auto h-3 w-6 shrink-0 rounded-sm bg-success/30" />
              <Skeleton className="h-3 w-6 shrink-0 rounded-sm bg-destructive/30" />
            </div>
            <Skeleton className="h-7 w-14 shrink-0 rounded-md" />
          </div>
          <DiffContentLoadingSkeleton
            mode={props.mode}
            sizing="content"
            density="compact"
            sectionIndex={sectionIndex}
          />
        </div>
      ))}
    </div>
  );
}
