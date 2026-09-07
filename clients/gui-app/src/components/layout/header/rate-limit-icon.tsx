import { useEffect, useState, type ReactNode } from "react";
import { Gauge } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverTrigger } from "@/components/ui/popover";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { RateLimitPopover } from "@/components/layout/header/rate-limit-popover";
import {
  useHeaderRateLimitBars,
  type HeaderRateLimitBar,
} from "@/hooks/rate-limits/use-header-rate-limit-bars";
import { useRateLimitResolveHostScope } from "@/hooks/rate-limits/use-rate-limit-host-scope";
import {
  useRateLimitProfileSelection,
  type RateLimitProfileSelection,
} from "@/hooks/rate-limits/use-rate-limit-profile-selection";
import { isHostScopeUsable } from "@/components/settings/host-scope/host-scope-status";
import { useScopedHostBinding } from "@/components/settings/host-scope/use-scoped-host-binding";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
import { useTitleBarDragSuppression } from "@/stores/layout/title-bar-drag-store";
import { HostRuntimeContext, useHostBinding } from "@/lib/host";
import {
  rateLimitWindowFillPercent,
  rateLimitWindowSeverityBarClassName,
} from "@/lib/rate-limits/window-severity";
import { cn } from "@/lib/utils";
import { registerDynamicActionHandler } from "@/lib/keybindings/dispatch";
import { formatChordForDisplay } from "@/lib/keybindings/chord";
import { useBindingForAction } from "@/stores/settings/keybinding-store";

const EMPTY_BAR_KEYS = ["primary", "secondary"] as const;

/** Stable identity so the placeholder path never re-renders on a new array. */
const NO_BARS: ReadonlyArray<HeaderRateLimitBar> = [];

/** The provider is rendered unconditionally, and that is load-bearing rather than tidiness. */
export function RateLimitIconButton(): ReactNode {
  const { scope, hasExplicitPick } = useRateLimitResolveHostScope();
  const scopedBinding = useScopedHostBinding(scope);
  const ambientBinding = useHostBinding();
  return (
    <HostRuntimeContext.Provider value={scopedBinding ?? ambientBinding}>
      <ScopedRateLimitIconButton
        scope={scope}
        hasExplicitPick={hasExplicitPick}
      />
    </HostRuntimeContext.Provider>
  );
}

/** Never gates on data loading: `useHeaderRateLimitBars` returns `[]` both before any provider has data and
 * when zero providers are configured, and both render the same neutral empty tracks. */
function ScopedRateLimitIconButton({
  scope,
  hasExplicitPick,
}: {
  readonly scope: HostScope;
  readonly hasExplicitPick: boolean;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const chord = useBindingForAction("app.rate-limits.open");
  useEffect(
    () =>
      registerDynamicActionHandler("app.rate-limits.open", () => {
        setOpen(true);
      }),
    [],
  );
  useTitleBarDragSuppression("rate-limits", open);
  // Passing the same snapshot down avoids N duplicate chat-store subscriptions when the Overview renders several
  // multi-profile provider blocks.
  const profileSelection = useRateLimitProfileSelection();
  // Blanking the bars there would be a regression paid by every single-host user for a picker they never opened.
  const scopedToOwnHost = !hasExplicitPick || isHostScopeUsable(scope.status);
  const tooltipLabel = scope.isViewingActive
    ? "Usage limits"
    : `Usage limits · ${scope.hostLabel}`;
  const tooltip =
    chord === null
      ? tooltipLabel
      : `${tooltipLabel} (${formatChordForDisplay(chord)})`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <TooltipWrapper
        // The host belongs in the label only when it is not the obvious one. Naming the active host on every hover
        // would train people to ignore the one case the words exist for.
        label={tooltip}
        side="top"
        sideOffset={6}
        align={undefined}
      >
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label="Usage limits"
            data-testid="rate-limit-header-button"
            className="gap-1.5 bg-muted/30 px-2 text-muted-foreground shadow-xs hover:text-foreground"
          >
            {scopedToOwnHost ? (
              <LiveRateLimitGlyph profileSelection={profileSelection} />
            ) : (
              <RateLimitGlyph bars={NO_BARS} />
            )}
          </Button>
        </PopoverTrigger>
      </TooltipWrapper>
      <RateLimitPopover
        onClose={() => setOpen(false)}
        profileSelection={profileSelection}
        scope={scope}
        hasExplicitPick={hasExplicitPick}
      />
    </Popover>
  );
}

/** Split from `RateLimitGlyph` so the hook is mounted only when this subtree is actually bound to the host
 * being displayed - see `scopedToOwnHost` above. */
function LiveRateLimitGlyph({
  profileSelection,
}: {
  readonly profileSelection: RateLimitProfileSelection;
}): ReactNode {
  const bars = useHeaderRateLimitBars(profileSelection);
  return <RateLimitGlyph bars={bars} />;
}

function RateLimitGlyph({
  bars,
}: {
  readonly bars: ReadonlyArray<HeaderRateLimitBar>;
}): ReactNode {
  const isEmpty = bars.length === 0;
  const isDegraded = !isEmpty && bars.some((bar) => bar.degraded);
  return (
    <>
      <Gauge
        data-testid="rate-limit-gauge-icon"
        className={cn(
          "size-3.5",
          isDegraded && "text-amber-600 dark:text-amber-400",
        )}
        aria-hidden
      />
      <span
        aria-hidden
        className="inline-flex flex-col items-start gap-[2.5px]"
      >
        {isEmpty
          ? EMPTY_BAR_KEYS.map((key) => (
              <span
                key={key}
                data-testid="rate-limit-bar-track"
                className="relative h-1 w-4 overflow-hidden rounded-[2px] bg-muted-foreground/35 dark:bg-muted-foreground/40"
              />
            ))
          : bars.map((bar) => (
              <span
                key={`${bar.providerId}-${bar.windowLabel}`}
                data-testid="rate-limit-bar-track"
                className="relative h-1 w-4 overflow-hidden rounded-[2px] bg-muted-foreground/35 dark:bg-muted-foreground/40"
              >
                <span
                  data-testid="rate-limit-bar-fill"
                  className={cn(
                    "absolute inset-y-0 left-0 rounded-[2px]",
                    rateLimitWindowSeverityBarClassName(bar.severity),
                  )}
                  style={{
                    width: `${rateLimitWindowFillPercent(bar.usedPercent)}%`,
                  }}
                />
              </span>
            ))}
      </span>
    </>
  );
}
