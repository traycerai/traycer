import { useState, type ReactNode } from "react";
import { Gauge } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverTrigger } from "@/components/ui/popover";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { RateLimitPopover } from "@/components/layout/header/rate-limit-popover";
import { useHeaderRateLimitBars } from "@/hooks/rate-limits/use-header-rate-limit-bars";
import { useRateLimitProfileSelection } from "@/hooks/rate-limits/use-rate-limit-profile-selection";
import { useTitleBarDragSuppression } from "@/stores/layout/title-bar-drag-store";
import {
  rateLimitWindowFillPercent,
  rateLimitWindowSeverityBarClassName,
} from "@/lib/rate-limits/window-severity";
import { cn } from "@/lib/utils";

const EMPTY_BAR_KEYS = ["primary", "secondary"] as const;

/**
 * Header trigger for the provider rate-limit popover. Its compact outlined
 * surface combines a recognizable gauge icon with the two live usage bars, so
 * the control still reads as an intentional button when both fills are 0%.
 * Clicking opens the popover in any glyph state, including empty (which lands
 * on the zero-provider CTA).
 *
 * Never gates on data loading: `useHeaderRateLimitBars` returns `[]` both
 * before any provider has data and when zero providers are configured, and
 * both render the same neutral empty tracks - there is no separate loading
 * state and no fabricated placeholder usage.
 */
export function RateLimitIconButton(): ReactNode {
  const [open, setOpen] = useState(false);
  useTitleBarDragSuppression("rate-limits", open);
  // One subscription bridge owns active-chat + per-harness profile state for
  // both the always-mounted glyph and the lazily-mounted popover. Passing the
  // same snapshot down avoids N duplicate chat-store subscriptions when the
  // Overview renders several multi-profile provider blocks.
  const profileSelection = useRateLimitProfileSelection();
  const bars = useHeaderRateLimitBars(profileSelection);
  const isEmpty = bars.length === 0;
  const isDegraded = !isEmpty && bars.some((bar) => bar.degraded);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <TooltipWrapper
        label="Usage limits"
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
          </Button>
        </PopoverTrigger>
      </TooltipWrapper>
      <RateLimitPopover
        onClose={() => setOpen(false)}
        profileSelection={profileSelection}
      />
    </Popover>
  );
}
