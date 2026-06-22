import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { useRefreshSpinner } from "@/hooks/use-refresh-spinner";

// Hard cap on the spinning/disabled state so a hung refetch can't wedge the
// button; a normal catalog/provider refetch settles in well under a second.
const REFRESH_TIMEOUT_MS = 10_000;

interface RefreshIconButtonProps {
  /** Invalidates + refetches; resolves when the refetch settles. */
  readonly onRefresh: () => Promise<void>;
  /** Accessible name + tooltip. */
  readonly label: string;
  /** Extra classes for placement (margin/spacing). */
  readonly className?: string;
  /** External loading state when the caller's backing query remains active. */
  readonly refreshing?: boolean;
}

/**
 * A refresh affordance shared by the model picker and the providers settings
 * panel: while a refresh is in flight the icon spins and the button is
 * disabled, re-enabling when the refetch completes or after a 10s safety cap. A
 * run id guards against a slow earlier run's completion clearing a newer run's
 * spinner.
 */
export function RefreshIconButton(props: RefreshIconButtonProps) {
  const { onRefresh, label, className, refreshing: externalRefreshing } = props;
  const { refreshing, trigger } = useRefreshSpinner({
    onRefresh,
    externalRefreshing: externalRefreshing === true,
    timeoutMs: REFRESH_TIMEOUT_MS,
  });

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={trigger}
      disabled={refreshing}
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent disabled:hover:text-muted-foreground",
        className,
      )}
    >
      <RefreshCw className={cn("size-4", refreshing && "animate-spin")} />
    </button>
  );
}
