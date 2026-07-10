import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverTrigger } from "@/components/ui/popover";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { RateLimitPopover } from "@/components/layout/header/rate-limit-popover";
import { useHeaderRateLimitBars } from "@/hooks/rate-limits/use-header-rate-limit-bars";
import { useRateLimitProfileSelection } from "@/hooks/rate-limits/use-rate-limit-profile-selection";
import {
  rateLimitWindowFillPercent,
  rateLimitWindowSeverityBarClassName,
} from "@/lib/rate-limits/window-severity";
import { cn } from "@/lib/utils";

/**
 * Fixed placeholder fill percentages for the neutral/no-data glyph (Core
 * Flows wireframe, CodexBar-style generic pre-filled look) - shown both when
 * zero providers are configured and while every provider's first fetch is
 * still pending. Not real usage data.
 */
const PLACEHOLDER_BAR_PERCENTAGES: ReadonlyArray<number> = [75, 60];

/**
 * Header trigger for the provider rate-limit popover. Same `TooltipWrapper` +
 * `Button variant="ghost" size="icon-sm"` structural pattern as
 * `HistoryButton`, always visible per Core Flows' "Entry point & visibility"
 * (position consistency + feature discovery beat hiding an empty state).
 * Clicking opens the popover in any glyph state, including empty (which lands on
 * the zero-provider CTA).
 *
 * Never gates on data loading: `useHeaderRateLimitBars` returns `[]` both
 * before any provider has data and when zero providers are configured, and
 * both render the same neutral glyph - there is no separate loading state.
 */
export function RateLimitIconButton(): ReactNode {
  const [open, setOpen] = useState(false);
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
            variant="ghost"
            size="icon-sm"
            aria-label="Usage limits"
            data-testid="rate-limit-header-button"
            className={cn(
              "text-muted-foreground hover:text-foreground",
              isEmpty && "opacity-50",
              isDegraded && "opacity-[0.55]",
            )}
          >
            <span
              aria-hidden
              className="inline-flex flex-col items-start gap-[2.5px]"
            >
              {isEmpty
                ? PLACEHOLDER_BAR_PERCENTAGES.map((percent) => (
                    <span
                      key={percent}
                      data-testid="rate-limit-bar-track"
                      className="relative h-1 w-4 overflow-hidden rounded-[2px] bg-muted"
                    >
                      <span
                        data-testid="rate-limit-bar-fill"
                        className="absolute inset-y-0 left-0 rounded-[2px] bg-muted-foreground"
                        style={{ width: `${percent}%` }}
                      />
                    </span>
                  ))
                : bars.map((bar) => (
                    <span
                      key={`${bar.providerId}-${bar.windowLabel}`}
                      data-testid="rate-limit-bar-track"
                      className="relative h-1 w-4 overflow-hidden rounded-[2px] bg-muted"
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
