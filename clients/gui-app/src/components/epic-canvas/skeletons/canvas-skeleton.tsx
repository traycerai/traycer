import { Skeleton } from "@/components/ui/skeleton";

export function CanvasSkeleton() {
  return (
    <div
      className="h-full min-h-0 w-full overflow-hidden p-6"
      data-testid="canvas-skeleton"
      aria-busy="true"
    >
      <div className="mx-auto flex max-w-3xl flex-col gap-3">
        <Skeleton className="h-5 w-1/3 rounded" />
        <Skeleton className="h-3 w-full rounded" />
        <Skeleton className="h-3 w-5/6 rounded" />
        <Skeleton className="h-3 w-4/6 rounded" />
      </div>
    </div>
  );
}
