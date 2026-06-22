/**
 * Pre-hydration placeholder for the header tab strip.
 *
 * Persisted strip refs hydrate synchronously from `localStorage`, but
 * the canvas / landing-draft data those refs point at lands later via
 * `WindowsBridgeProvider`'s async snapshot. Showing the real header
 * tabs immediately would briefly render orphan refs (then drop them
 * once reconciliation runs) - flashing the strip on every cold start.
 *
 * The skeleton renders one neutral placeholder per persisted ref so
 * the strip's footprint and tab count stay stable across the
 * hydration boundary. After `WindowsBridgeContext.hasHydrated` flips
 * true, the real `TabStrip` body swaps in.
 */
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

interface TabStripSkeletonProps {
  readonly count: number;
}

export function TabStripSkeleton({ count }: TabStripSkeletonProps) {
  return (
    <div
      data-testid="tab-strip-skeleton"
      aria-busy
      aria-label="Restoring open tabs"
      className={cn(
        "flex h-10 w-full min-w-0 items-center gap-1 px-2",
        "[-webkit-app-region:drag]",
      )}
    >
      {Array.from({ length: count }, (_, index) => (
        <Skeleton
          key={index}
          data-testid="tab-strip-skeleton-item"
          className="h-7 w-32 rounded-md [-webkit-app-region:no-drag]"
        />
      ))}
    </div>
  );
}
