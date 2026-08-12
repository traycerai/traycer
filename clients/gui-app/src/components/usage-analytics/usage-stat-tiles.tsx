import type { ReactNode } from "react";
import { formatUsd } from "@/lib/usage-analytics/cost-format";
import type { UsageStatTiles as UsageStatTilesData } from "@/lib/usage-analytics/usage-stat-tiles";
import { cn } from "@/lib/utils";

export interface UsageStatTilesProps {
  readonly tiles: UsageStatTilesData;
}

const TOKEN_FORMAT = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const PLAIN_TOKEN_FORMAT = new Intl.NumberFormat("en-US");

function formatTokens(value: number): string {
  return TOKEN_FORMAT.format(value);
}

/**
 * Five stat tiles: processed tokens, cached input, uncached input, output,
 * cache savings. Every secondary line is conditional on a real, non-null
 * figure from `usage-stat-tiles.ts` - never an implied zero for a signal a
 * harness simply did not report (the ticket's binding honesty rule).
 */
export function UsageStatTiles(props: UsageStatTilesProps): ReactNode {
  const { tiles } = props;
  return (
    <div
      className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5"
      data-testid="usage-stat-tiles"
    >
      <StatTile
        testId="usage-stat-tile-processed"
        label="Processed tokens"
        value={formatTokens(tiles.processedTokens.totalTokens)}
        detail={
          tiles.processedTokens.perActiveDay === null
            ? null
            : `${formatTokens(tiles.processedTokens.perActiveDay)} / active day`
        }
      />
      <StatTile
        testId="usage-stat-tile-cached"
        label="Cached input"
        value={formatTokens(tiles.cachedInput.cacheReadInputTokens)}
        detail={
          tiles.cachedInput.percentOfObservedInput === null
            ? null
            : `${tiles.cachedInput.percentOfObservedInput.toFixed(0)}% of observed input`
        }
      />
      <StatTile
        testId="usage-stat-tile-uncached"
        label="Uncached input"
        value={formatTokens(tiles.uncachedInput.uncachedInputTokens)}
        detail={
          tiles.uncachedInput.cacheCreationTokens > 0
            ? `+ ${PLAIN_TOKEN_FORMAT.format(tiles.uncachedInput.cacheCreationTokens)} cache writes`
            : null
        }
      />
      <StatTile
        testId="usage-stat-tile-output"
        label="Output"
        value={formatTokens(tiles.output.outputTokens)}
        detail={
          tiles.output.reasoningTokens === null
            ? null
            : `includes ${PLAIN_TOKEN_FORMAT.format(tiles.output.reasoningTokens)} reasoning`
        }
      />
      <StatTile
        testId="usage-stat-tile-savings"
        label="Cache savings"
        value={formatUsd(tiles.cacheSavings.knownCacheSavingsUsd)}
        detail={
          tiles.cacheSavings.multipleOfRawCost === null
            ? null
            : `${tiles.cacheSavings.multipleOfRawCost.toFixed(1)}x raw cost`
        }
      />
    </div>
  );
}

function StatTile(props: {
  readonly testId: string;
  readonly label: string;
  readonly value: string;
  readonly detail: string | null;
}): ReactNode {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-0.5 rounded-lg border border-border/60 bg-card/40 px-3 py-2.5",
      )}
      data-testid={props.testId}
    >
      <span className="truncate text-ui-xs text-muted-foreground">
        {props.label}
      </span>
      <span className="truncate text-ui font-semibold tabular-nums text-foreground">
        {props.value}
      </span>
      {props.detail === null ? null : (
        <span className="truncate text-ui-xs text-muted-foreground/80">
          {props.detail}
        </span>
      )}
    </div>
  );
}
