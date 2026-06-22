import type { CSSProperties } from "react";
import type { TokenUsage } from "@traycer/protocol/persistence/epic/foundation";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import {
  computeEffectiveContextUsage,
  type EffectiveContextUsage,
} from "@/components/chat/context-usage";
import { cn } from "@/lib/utils";

interface ContextUsageChipProps {
  /**
   * Latest assistant-turn token usage, or `null` if no completed turn has
   * carried a usage rollup yet. The chip hides when this is `null`, when
   * `usage.contextWindow` is missing, or when the computed remaining
   * percent isn't a finite number.
   */
  readonly usage: TokenUsage | null;
}

type ContextUsageMeterStyle = CSSProperties & {
  readonly "--context-usage-percent": string;
};

export function ContextUsageChip({ usage }: ContextUsageChipProps) {
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
  return (
    <TooltipWrapper
      label={<ContextUsageBreakdown usage={usage} effective={effective} />}
      side="top"
      align="end"
      sideOffset={6}
    >
      <output
        aria-label={`Context window ${percent}% left`}
        data-testid="context-usage-chip"
        className={cn(
          "shrink-0 cursor-default whitespace-nowrap text-ui-sm font-normal tabular-nums opacity-70",
          contextUsageTone(percent),
        )}
      >
        <span className="@max-[28rem]:sr-only">{percent}% context left</span>
        <span
          aria-hidden
          data-testid="context-usage-meter"
          className="hidden size-5 rounded-full bg-[conic-gradient(currentColor_var(--context-usage-percent),var(--muted)_0)] p-[3px] @max-[28rem]:inline-flex"
          style={meterStyle}
        >
          <span className="size-full rounded-full bg-canvas" />
        </span>
      </output>
    </TooltipWrapper>
  );
}

interface ContextUsageBreakdownProps {
  readonly usage: TokenUsage;
  readonly effective: EffectiveContextUsage;
}

function ContextUsageBreakdown({
  usage,
  effective,
}: ContextUsageBreakdownProps) {
  const cacheRead = usage.cacheReadInputTokens ?? 0;
  const cacheCreate = usage.cacheCreationInputTokens ?? 0;
  // Show the same "used / window" pair the headline percent is computed from.
  // `effective.used` includes fixed baseline tokens when a harness reports
  // them, but the baseline is not repeated as a separate hover row.
  const used = effective.used;
  // "Fresh" = portion of `used` that wasn't served from cache. Hidden when
  // there's no cache - then "Used" already tells the whole story and "Fresh"
  // would just duplicate it.
  const fresh = Math.max(0, used - cacheRead - cacheCreate);
  const hasCache = cacheRead > 0 || cacheCreate > 0;
  return (
    <div className="flex flex-col gap-1.5 text-ui-xs">
      <div className="flex items-baseline justify-between gap-3 border-b border-border/40 pb-1.5">
        <span className="font-medium">Token usage</span>
        <span className="font-mono tabular-nums">
          {effective.percentLeft}% left
        </span>
      </div>
      <UsageRow label="Used" value={used} total={effective.window} />
      {hasCache ? <UsageRow label="Fresh" value={fresh} total={null} /> : null}
      {cacheRead > 0 ? (
        <UsageRow label="Cache read" value={cacheRead} total={null} />
      ) : null}
      {cacheCreate > 0 ? (
        <UsageRow label="Cache write" value={cacheCreate} total={null} />
      ) : null}
      <UsageRow label="Output" value={usage.outputTokens} total={null} />
    </div>
  );
}

interface UsageRowProps {
  readonly label: string;
  readonly value: number;
  readonly total: number | undefined | null;
}

function UsageRow({ label, value, total }: UsageRowProps) {
  const hasTotal = total !== undefined && total !== null;
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span>{label}</span>
      <span className="font-mono tabular-nums">
        {hasTotal ? formatContextWindowTokens(value) : formatTokens(value)}
        {hasTotal ? ` / ${formatContextWindowTokens(total)}` : null}
      </span>
    </div>
  );
}

function contextUsageTone(percent: number): string {
  if (percent <= 10) return "text-destructive";
  if (percent <= 25) return "text-amber-500 dark:text-amber-400";
  return "text-muted-foreground";
}

function contextUsageMeterStyle(percent: number): ContextUsageMeterStyle {
  const usedPercent = 100 - percent;
  return {
    "--context-usage-percent": `${usedPercent}%`,
  };
}

/**
 * Compact token formatter for the tooltip rows: 1_234 → "1.2k",
 * 1_234_567 → "1.2M". Falls back to raw `toLocaleString` for values < 1k so
 * tiny output-only turns aren't misleadingly rounded.
 */
function formatTokens(value: number): string {
  if (value < 1_000) return value.toLocaleString();
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

function formatContextWindowTokens(value: number): string {
  if (value < 1_000) return value.toLocaleString();
  if (value < 1_000_000) {
    return `${Math.round(value / 1_000).toLocaleString()}K`;
  }
  return `${Math.round(value / 1_000_000).toLocaleString()}M`;
}
