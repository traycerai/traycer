import type { ReactNode } from "react";
import { LineChart } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { UsageErrorCard } from "@/components/usage-analytics/usage-error-card";
import { cn } from "@/lib/utils";

export interface UsageDialogSkeletonProps {
  /** Which dialog's loaded layout to mirror - the epic mini-dashboard or the chat hero + turn list. */
  readonly variant: "epic" | "chat";
}

/**
 * `Skeleton`'s default `bg-muted` fill is invisible on this dialog: the
 * surface is the primitive's `bg-popover`, and most preset themes define
 * `--muted` IDENTICAL to `--popover` (amoled, dracula, catppuccin,
 * tokyo-night, github, nord, gruvbox, ayu, everforest, traycer-green - only
 * the default light/dark pair separates them). A foreground-alpha fill
 * contrasts with whatever surface it sits on, in every theme, by
 * construction.
 */
const SKELETON_ON_POPOVER = "bg-foreground/10";

function DialogSkeleton(props: { readonly className: string }): ReactNode {
  return <Skeleton className={cn(SKELETON_ON_POPOVER, props.className)} />;
}

/**
 * Loading fill that mirrors the loaded layout - the same hero grid, chart
 * clamp, and row rhythm as the data that replaces it, so nothing shifts
 * when it lands. Deliberately not a spinner (and outside the
 * `AgentSpinningDots` rule for that reason): a skeleton at the loaded
 * layout's own shape IS the fixed frame's no-jump guarantee.
 */
export function UsageDialogSkeleton(
  props: UsageDialogSkeletonProps,
): ReactNode {
  return (
    <div role="status" aria-busy="true" data-testid="usage-dialog-skeleton">
      {/* The blocks below are decorative (`aria-hidden`), so without this the
          state has no accessible name at all and a screen reader gets nothing
          between open and data - the spinner this replaced at least carried a
          "Loading usage…" label. `role="status"` announces it politely and
          again when the data swaps it out. */}
      <span className="sr-only">Loading usage…</span>
      <div
        aria-hidden
        className={cn(
          "flex flex-col",
          props.variant === "epic" ? "gap-5" : "gap-3",
        )}
      >
        {props.variant === "epic" ? (
          <EpicUsageSkeletonBlocks />
        ) : (
          <ChatUsageSkeletonBlocks />
        )}
      </div>
    </div>
  );
}

/**
 * Mirrors `EpicUsageLoadedBody`: hero zone (headline + split left, 2x2
 * tiles right, folding to one column with the same container query), the
 * chart at its exact height clamp, then breakdown table lines.
 */
function EpicUsageSkeletonBlocks(): ReactNode {
  return (
    <>
      <div className="grid grid-cols-1 gap-4 @min-[40rem]:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-col gap-2">
            <DialogSkeleton className="h-8 w-1/3" />
            <DialogSkeleton className="h-3 w-1/2" />
          </div>
          <div className="flex flex-col gap-2.5">
            <DialogSkeleton className="h-3.5 w-full" />
            <DialogSkeleton className="h-3.5 w-full" />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <DialogSkeleton className="h-16" />
          <DialogSkeleton className="h-16" />
          <DialogSkeleton className="h-16" />
          <DialogSkeleton className="h-16" />
        </div>
      </div>
      <DialogSkeleton className="h-[clamp(11rem,26vh,16rem)] w-full" />
      <div className="flex flex-col gap-2.5">
        <DialogSkeleton className="h-3.5 w-full" />
        <DialogSkeleton className="h-3.5 w-full" />
        <DialogSkeleton className="h-3.5 w-2/3" />
      </div>
    </>
  );
}

/** Mirrors the chat dialog's loaded body: hero figure + turn-row lines. */
function ChatUsageSkeletonBlocks(): ReactNode {
  return (
    <>
      <div className="flex flex-col gap-2">
        <DialogSkeleton className="h-8 w-1/3" />
        <DialogSkeleton className="h-3 w-1/2" />
      </div>
      <div className="flex flex-col gap-2.5">
        <DialogSkeleton className="h-3.5 w-full" />
        <DialogSkeleton className="h-3.5 w-full" />
        <DialogSkeleton className="h-3.5 w-2/3" />
      </div>
    </>
  );
}

export interface UsageDialogEmptyProps {
  readonly headline: string;
  readonly hint: string;
  /**
   * The plane/scope qualification that `UsageCostFigure` carries on a loaded
   * read (`servedByScopeNote`) - `null` when the read needs none. Empty is a
   * CLAIM ("no usage"), and a local-plane zero only means this machine has
   * none, so the qualification has to survive the route into this state
   * rather than disappearing with the figure that used to render it.
   */
  readonly note: string | null;
  /** Action chips below the hint (the epic dialog's wider-window offers) - `null` when the state has no action to offer. */
  readonly children: ReactNode;
}

/** Centered empty composition at the frame's constant size: icon ring, headline, hint, optional actions. */
export function UsageDialogEmpty(props: UsageDialogEmptyProps): ReactNode {
  return (
    <div
      className="flex h-full min-h-0 flex-col items-center justify-center gap-3 px-4 py-6 text-center"
      data-testid="usage-dialog-empty"
    >
      {/* `bg-foreground/10`, not `bg-muted`, for the SKELETON_ON_POPOVER
          reason: preset themes collapse `--muted` into `--popover`, which
          would leave the icon floating without its ring. */}
      <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-foreground/10 text-muted-foreground">
        <LineChart className="size-5" aria-hidden />
      </div>
      <div className="space-y-1">
        <p className="text-ui font-medium text-foreground">{props.headline}</p>
        <p className="mx-auto max-w-[36ch] text-ui-sm text-muted-foreground">
          {props.hint}
        </p>
        {props.note === null ? null : (
          <p
            className="mx-auto max-w-[36ch] text-ui-xs text-muted-foreground/80"
            data-testid="usage-served-by-local-note"
          >
            {props.note}
          </p>
        )}
      </div>
      {props.children}
    </div>
  );
}

export interface UsageDialogErrorStateProps {
  readonly error: Error;
  readonly onRetry: () => void;
}

/** Centers the existing retryable card in the fixed frame - the card itself is reused unmodified. */
export function UsageDialogErrorState(
  props: UsageDialogErrorStateProps,
): ReactNode {
  return (
    <div className="flex h-full flex-col justify-center py-6">
      <div className="mx-auto w-full max-w-md">
        <UsageErrorCard error={props.error} onRetry={props.onRetry} />
      </div>
    </div>
  );
}

/** The settled-but-dataless fill (no error, no response), centered in the same frame. */
export function UsageDialogUnavailable(): ReactNode {
  return (
    <div className="flex h-full items-center justify-center py-6">
      <p className="text-ui-sm text-muted-foreground">
        Usage data unavailable.
      </p>
    </div>
  );
}
