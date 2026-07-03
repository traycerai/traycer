import { useLayoutEffect, useRef, type CSSProperties, type Ref } from "react";
import { Pin, PinOff } from "lucide-react";
import {
  animate,
  useMotionValue,
  useReducedMotion,
  useTransform,
} from "motion/react";
import * as m from "motion/react-m";
import type { TokenUsage } from "@traycer/protocol/persistence/epic/foundation";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import {
  buildContextUsageRows,
  computeEffectiveContextUsage,
  contextUsageTone,
  formatContextWindowTokens,
  formatContextUsageRowValue,
  type ContextUsageRow,
  type EffectiveContextUsage,
} from "@/components/chat/context-usage";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import {
  ProviderRateLimitBody,
  ProviderRateLimitCompactRow,
} from "@/components/settings/panels/provider-rate-limit-views";
import { useTabHostProviderRateLimitsQuery } from "@/hooks/host/use-tab-host-provider-rate-limits-query";
import { useRefreshProviderRateLimitsOnTurn } from "@/hooks/host/use-refresh-provider-rate-limits-on-turn";
import { hasProviderRateLimitContent } from "@/lib/provider-rate-limit-content";
import type { RateLimitProviderId } from "@/lib/rate-limit-providers";
import { cn } from "@/lib/utils";
import { useSettingsStore } from "@/stores/settings/settings-store";

interface ContextUsageChipProps {
  /**
   * Latest assistant-turn token usage, or `null` if no completed turn has
   * carried a usage rollup yet. The chip hides when this is `null`, when
   * `usage.contextWindow` is missing, or when the computed remaining
   * percent isn't a finite number.
   */
  readonly usage: TokenUsage | null;
  /**
   * The chat's currently-selected provider, when it's one
   * `host.getRateLimitUsage`'s provider-pull branch supports. Drives an
   * additional rate-limit section in the popover and a compact row in the
   * pinned strip; `null` renders neither (a Traycer chat, another provider,
   * or no provider resolved yet).
   */
  readonly providerId: RateLimitProviderId | null;
}

type ContextUsageMeterStyle = CSSProperties & {
  readonly "--context-usage-percent": string;
};

const PINNED_NUMBER_TRANSITION = {
  duration: 0.16,
  ease: "easeOut",
} as const;

export function ContextUsageChip({ usage, providerId }: ContextUsageChipProps) {
  const preserveFocusOnOpenRef = useRef(false);
  const pinBreakdownActionRef = useRef<HTMLButtonElement>(null);
  const compactTriggerRef = useRef<HTMLButtonElement>(null);
  const pinnedUnpinActionRef = useRef<HTMLButtonElement>(null);
  const focusPinnedActionAfterPinRef = useRef(false);
  const focusCompactTriggerAfterUnpinRef = useRef(false);
  const pinContextUsageBreakdown = useSettingsStore(
    (s) => s.pinContextUsageBreakdown,
  );
  const setPinContextUsageBreakdown = useSettingsStore(
    (s) => s.setPinContextUsageBreakdown,
  );

  useLayoutEffect(() => {
    if (pinContextUsageBreakdown && focusPinnedActionAfterPinRef.current) {
      focusPinnedActionAfterPinRef.current = false;
      pinnedUnpinActionRef.current?.focus();
      return;
    }
    if (!pinContextUsageBreakdown && focusCompactTriggerAfterUnpinRef.current) {
      focusCompactTriggerAfterUnpinRef.current = false;
      compactTriggerRef.current?.focus();
    }
  }, [pinContextUsageBreakdown]);

  if (usage === null) return null;
  const effective = computeEffectiveContextUsage(usage);
  // The chip ONLY renders when we can compute a reliable percent from the
  // harness's real SDK data (`contextTokens` + `contextWindow` both
  // sourced from the SDK, no hardcoded fallbacks). For harnesses where
  // either signal is missing - Cursor today, since its SDK exposes no
  // public context-window surface - the chip stays hidden. Raw token
  // counts on their own would mislead without a denominator, so we don't
  // show them.
  if (effective === null) return null;
  const percent = effective.percentLeft;
  const meterStyle = contextUsageMeterStyle(percent);
  const rows = buildContextUsageRows(usage, effective);
  const unpinFromPinnedStrip = (restoreFocus: boolean) => {
    if (restoreFocus) {
      focusCompactTriggerAfterUnpinRef.current = true;
    }
    setPinContextUsageBreakdown(false);
  };

  if (pinContextUsageBreakdown) {
    return (
      <ContextUsagePinnedStrip
        rows={rows}
        effective={effective}
        providerId={providerId}
        onUnpin={unpinFromPinnedStrip}
        actionRef={pinnedUnpinActionRef}
      />
    );
  }

  const pinFromPopover = (value: boolean, restoreFocus: boolean) => {
    if (value && restoreFocus) {
      focusPinnedActionAfterPinRef.current = true;
    }
    setPinContextUsageBreakdown(value);
  };

  return (
    <div className="min-w-0 justify-self-end">
      <Popover>
        <PopoverTrigger asChild>
          <button
            ref={compactTriggerRef}
            type="button"
            aria-label={`Context window ${percent}% left. Open context usage breakdown`}
            data-testid="context-usage-chip"
            className={cn(
              "inline-flex shrink-0 items-center rounded-sm bg-transparent text-ui-sm font-normal tabular-nums whitespace-nowrap opacity-70 transition-colors outline-none hover:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50",
              contextUsageTone(percent),
            )}
            onPointerDown={() => {
              preserveFocusOnOpenRef.current = true;
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                preserveFocusOnOpenRef.current = false;
              }
            }}
          >
            <span className="@max-[28rem]:sr-only">
              {percent}% context left
            </span>
            <span
              aria-hidden
              data-testid="context-usage-meter"
              className="hidden size-5 rounded-full bg-[conic-gradient(currentColor_var(--context-usage-percent),var(--muted)_0)] p-[3px] @max-[28rem]:inline-flex"
              style={meterStyle}
            >
              <span className="size-full rounded-full bg-canvas" />
            </span>
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          side="top"
          sideOffset={6}
          aria-label="Context usage breakdown"
          className="w-[min(90vw,18rem)] gap-2.5 p-2.5"
          onOpenAutoFocus={(event) => {
            if (preserveFocusOnOpenRef.current) {
              event.preventDefault();
            } else {
              event.preventDefault();
              pinBreakdownActionRef.current?.focus();
            }
            preserveFocusOnOpenRef.current = false;
          }}
        >
          <ContextUsageBreakdown
            rows={rows}
            effective={effective}
            providerId={providerId}
            pinned={pinContextUsageBreakdown}
            onPinnedChange={pinFromPopover}
            actionRef={pinBreakdownActionRef}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}

interface ContextUsageBreakdownProps {
  readonly rows: readonly ContextUsageRow[];
  readonly effective: EffectiveContextUsage;
  readonly providerId: RateLimitProviderId | null;
  readonly pinned: boolean;
  readonly onPinnedChange: (value: boolean, restoreFocus: boolean) => void;
  readonly actionRef: Ref<HTMLButtonElement>;
}

function ContextUsageBreakdown({
  rows,
  effective,
  providerId,
  pinned,
  onPinnedChange,
  actionRef,
}: ContextUsageBreakdownProps) {
  return (
    <div className="flex flex-col gap-2 text-ui-xs">
      <div className="flex items-baseline justify-between gap-3 border-b border-border/40 pb-1.5">
        <span className="font-medium text-foreground">Context window</span>
        <span className="font-mono tabular-nums">
          {effective.percentLeft}% left
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        {rows.map((row) => (
          <UsageRow key={row.key} row={row} />
        ))}
      </div>
      {providerId !== null ? (
        <ChatProviderRateLimitSection providerId={providerId} />
      ) : null}
      <Button
        ref={actionRef}
        type="button"
        variant="outline"
        size="sm"
        className="mt-1 w-full justify-center"
        onClick={(event) => {
          onPinnedChange(
            !pinned,
            document.activeElement === event.currentTarget,
          );
        }}
      >
        {pinned ? (
          <PinOff className="size-3.5" aria-hidden />
        ) : (
          <Pin className="size-3.5" aria-hidden />
        )}
        {pinned ? "Unpin breakdown" : "Pin breakdown"}
      </Button>
    </div>
  );
}

interface ContextUsagePinnedStripProps {
  readonly rows: readonly ContextUsageRow[];
  readonly effective: EffectiveContextUsage;
  readonly providerId: RateLimitProviderId | null;
  readonly onUnpin: (restoreFocus: boolean) => void;
  readonly actionRef: Ref<HTMLButtonElement>;
}

function ContextUsagePinnedStrip({
  rows,
  effective,
  providerId,
  onUnpin,
  actionRef,
}: ContextUsagePinnedStripProps) {
  const usedSummary = `${formatContextWindowTokens(effective.used)} / ${formatContextWindowTokens(effective.window)} used`;
  return (
    <div
      data-testid="context-usage-pinned-strip"
      className="col-span-full min-w-0 border-t border-border/40 pt-2 text-ui-xs"
    >
      <div className="flex min-w-0 items-center justify-between gap-2">
        <div className="flex min-w-0 flex-1 items-baseline gap-3">
          <span
            data-testid="context-usage-pinned-primary"
            className={cn(
              "shrink-0 font-medium whitespace-nowrap",
              contextUsageTone(effective.percentLeft),
            )}
          >
            Context{" "}
            <AnimatedPinnedInteger
              value={effective.percentLeft}
              testId="context-usage-pinned-percent-value"
              className="inline-block min-w-[3ch] text-right tabular-nums"
            />
            %<span className="@max-[34rem]:sr-only"> left</span>
          </span>
          <span
            data-testid="context-usage-pinned-summary"
            className="hidden min-w-0 truncate font-mono tabular-nums text-muted-foreground @max-[34rem]:block"
          >
            {usedSummary}
          </span>
          <div
            data-testid="context-usage-pinned-details"
            className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-1 @max-[34rem]:hidden"
          >
            {rows.map((row) => (
              <PinnedUsageRow key={row.key} row={row} />
            ))}
            {providerId !== null ? (
              <ChatProviderRateLimitCompact providerId={providerId} />
            ) : null}
          </div>
        </div>
        <TooltipWrapper
          label="Unpin context usage breakdown"
          side="top"
          sideOffset={6}
          align={undefined}
        >
          <Button
            ref={actionRef}
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Unpin context usage breakdown"
            className="text-muted-foreground hover:text-foreground"
            onClick={(event) => {
              onUnpin(document.activeElement === event.currentTarget);
            }}
          >
            <PinOff className="size-3.5" aria-hidden />
          </Button>
        </TooltipWrapper>
      </div>
    </div>
  );
}

interface UsageRowProps {
  readonly row: ContextUsageRow;
}

function UsageRow({ row }: UsageRowProps) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span>{row.label}</span>
      <span className="font-mono tabular-nums">
        {formatContextUsageRowValue(row)}
      </span>
    </div>
  );
}

function PinnedUsageRow({ row }: UsageRowProps) {
  return (
    <span className="inline-flex min-w-0 items-baseline gap-1.5 whitespace-nowrap text-muted-foreground">
      <span>{row.label}</span>
      <span className="font-mono tabular-nums text-foreground/80">
        {formatContextUsageRowValue(row)}
      </span>
    </span>
  );
}

interface AnimatedPinnedIntegerProps {
  readonly value: number;
  readonly testId: string;
  readonly className: string;
}

function AnimatedPinnedInteger({
  value,
  testId,
  className,
}: AnimatedPinnedIntegerProps) {
  const shouldReduceMotion = useReducedMotion() === true;
  const animatedValue = useMotionValue(value);
  const roundedValue = useTransform(animatedValue, (latest) =>
    Math.round(latest).toString(),
  );

  useLayoutEffect(() => {
    if (shouldReduceMotion) {
      animatedValue.set(value);
      return;
    }

    const controls = animate(animatedValue, value, PINNED_NUMBER_TRANSITION);
    return () => controls.stop();
  }, [animatedValue, shouldReduceMotion, value]);

  if (shouldReduceMotion) {
    return (
      <span data-testid={testId} className={className}>
        {value}
      </span>
    );
  }

  return (
    <m.span data-testid={testId} className={className}>
      {roundedValue}
    </m.span>
  );
}

function contextUsageMeterStyle(percent: number): ContextUsageMeterStyle {
  const usedPercent = 100 - percent;
  return {
    "--context-usage-percent": `${usedPercent}%`,
  };
}

/**
 * Owns the tab-scoped rate-limit query + turn-completion refresh for the
 * popover section, so `provider-rate-limit-views.tsx` stays host/query-free
 * and reusable across surfaces. Only mounted while `providerId` is
 * rate-limit-capable AND (via `PopoverContent`'s default lazy mount) the
 * popover is actually open, so this never polls in the background for a
 * chip the user hasn't opened.
 */
function ChatProviderRateLimitSection({
  providerId,
}: {
  readonly providerId: RateLimitProviderId;
}) {
  const tabHostId = useTabHostId();
  const query = useTabHostProviderRateLimitsQuery(providerId);
  useRefreshProviderRateLimitsOnTurn(providerId, tabHostId);
  const state = {
    isPending: query.isPending,
    isFetching: query.isFetching,
    isError: query.isError,
    providerRateLimits: query.data?.providerRateLimits,
  };
  // Own the border/padding chrome here (rather than in the always-rendered
  // popover breakdown) so a resolved-but-empty result - e.g. a v1.1 host
  // answering a v1.2 request, where `providerRateLimits` comes back `null` -
  // doesn't leave a bordered, empty-looking section in the popover.
  if (!hasProviderRateLimitContent(state)) return null;
  return (
    <div className="flex flex-col gap-1.5 border-t border-border/40 pt-1.5">
      <ProviderRateLimitBody {...state} />
    </div>
  );
}

/**
 * Compact counterpart of `ChatProviderRateLimitSection` for the pinned strip.
 * Mounted only while the strip is pinned, so - like the popover section - it
 * only queries for a chat the user has actually surfaced rate limits for.
 */
function ChatProviderRateLimitCompact({
  providerId,
}: {
  readonly providerId: RateLimitProviderId;
}) {
  const tabHostId = useTabHostId();
  const query = useTabHostProviderRateLimitsQuery(providerId);
  useRefreshProviderRateLimitsOnTurn(providerId, tabHostId);
  return (
    <ProviderRateLimitCompactRow
      isPending={query.isPending}
      isFetching={query.isFetching}
      isError={query.isError}
      providerRateLimits={query.data?.providerRateLimits}
    />
  );
}
