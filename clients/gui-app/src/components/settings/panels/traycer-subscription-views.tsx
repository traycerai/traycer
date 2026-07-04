/**
 * Presentational, query-free views for the Traycer subscription surface, shared
 * by the Settings › Providers › Traycer card (`traycer-subscription-section.tsx`)
 * and the header rate-limit popover's "Traycer" tab (`rate-limit-popover.tsx`) -
 * the same "one renderer, two surfaces" split `provider-rate-limit-views.tsx`
 * uses for the host-RPC providers, so the card and the popover can never
 * disagree.
 *
 * `TraycerSubscriptionView` is the shared body (credit/rate-limit breakdown -
 * no tier/trial badge; feedback: "badge is not needed, just show plan, bonus
 * and credits"). Unlike `ProviderRateLimitDetail`, it is NOT
 * variant-parameterized: the Traycer body has no per-model / extra-window rows
 * to drop, so the Overview-vs-detail difference is purely the surrounding
 * chrome (the account picker, the "Manage subscription" link), which each
 * caller composes around this body. Each bucket (Plan/Bonus/Bundle/Artifacts)
 * renders through `CreditMeterRow`, the same label-plus-side-bar row the
 * Codex/Claude windows use, so Traycer's own bars read identically
 * (feedback: "bar similar to claude/codex").
 *
 * The lone exception to "query-free" is `RateLimitView`, which keeps its own
 * `useHostRateLimitUsageQuery` + turn-refresh exactly as before: rendering it
 * only for rate-limit-based plans IS the tier-gate that stops the aperture pull
 * from firing on credit-based plans, so lifting the query to the callers would
 * either break that gate or mount it for every plan.
 */
import type { ReactNode } from "react";
import type { TraycerTeamSubscription } from "@traycer/protocol/auth";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useHostRateLimitUsageQuery } from "@/hooks/host/use-host-rate-limit-usage-query";
import { useRefreshRateLimitUsageOnTraycerTurn } from "@/hooks/host/use-refresh-rate-limit-usage-on-traycer-turn";
import {
  PERSONAL_VALUE,
  TEAM_VALUE_PREFIX,
  creditBreakdown,
  formatArtifactTokens,
  formatCredits,
  formatRechargeRate,
  isCreditBasedPricing,
  type CreditBreakdown,
  type TraycerSubscription,
} from "@/lib/auth/traycer-subscription-content";
import {
  rateLimitWindowFillPercent,
  rateLimitWindowSeverity,
  rateLimitWindowSeverityBarClassName,
} from "@/lib/rate-limits/window-severity";
import { cn } from "@/lib/utils";

/**
 * The Personal / Team account picker, shared by the Settings card header and the
 * popover's Traycer detail tab. Renders nothing when the user has no teams (the
 * only choice is Personal, so a one-option select is noise) - the caller can
 * always render it unconditionally.
 */
export function TraycerAccountSelect({
  teams,
  value,
  onValueChange,
}: {
  readonly teams: readonly TraycerTeamSubscription[];
  readonly value: string;
  readonly onValueChange: (value: string) => void;
}): ReactNode {
  if (teams.length === 0) return null;
  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger size="sm" aria-label="Account" className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={PERSONAL_VALUE}>Personal</SelectItem>
        {teams.map((team) => (
          <SelectItem
            key={team.team.id}
            value={`${TEAM_VALUE_PREFIX}${team.team.id}`}
          >
            {team.team.slug}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * The shared subscription body: either the credit breakdown (V3 credit plans)
 * or the rate-limit view (legacy / v2 plans) - now the single source both
 * surfaces render through.
 */
export function TraycerSubscriptionView({
  subscription,
}: {
  readonly subscription: TraycerSubscription;
}): ReactNode {
  const status = subscription.subscriptionStatus;
  return isCreditBasedPricing(status) ? (
    <CreditBreakdownView breakdown={creditBreakdown(subscription)} />
  ) : (
    <RateLimitView subscription={subscription} />
  );
}

// Rate-limit (legacy / v2) plans don't bill credits - they throttle artifact
// generation and refill at a recharge rate. Mirrors the extension's
// `RateLimitBasedPlanUsageDisplay` (recharge rate + artifact bar + bundle bar).
// Live artifact usage comes from aperture via `host.getRateLimitUsage`; when
// aperture is off or has no data (totalTokens === 0) we show "unavailable"
// rather than a 0-left bar (decision 2). Only rendered for rate-limit plans, so
// its `useHostRateLimitUsageQuery` mount is the implicit tier-gate.
function RateLimitView({
  subscription,
}: {
  readonly subscription: TraycerSubscription;
}) {
  const usageQuery = useHostRateLimitUsageQuery();
  // Keep the bar live: a Traycer turn finishing while this is on screen
  // re-fetches usage. Only mounted here, so it costs nothing elsewhere.
  useRefreshRateLimitUsageOnTraycerTurn();

  const recharge = formatRechargeRate(subscription.rechargeRateSeconds);
  const usage = usageQuery.data ?? null;
  const artifactTotal = usage?.totalTokens ?? 0;
  const artifactConsumed = Math.max(
    0,
    artifactTotal - (usage?.remainingTokens ?? 0),
  );
  const bundle = subscription.bundleSummary;
  const bundleTotal = bundle?.bundleTotal ?? 0;
  const bundleConsumed = Math.max(
    0,
    bundleTotal - (bundle?.bundleRemaining ?? 0),
  );
  return (
    <div className="flex flex-col gap-3">
      <span className="text-ui-sm font-medium text-foreground">Rate limit</span>
      {recharge !== null ? (
        <div className="flex items-center justify-between text-ui-sm">
          <span className="text-muted-foreground">New artifact every</span>
          <span className="font-medium text-foreground">{recharge}</span>
        </div>
      ) : null}
      {artifactTotal > 0 ? (
        <CreditMeterRow
          label="Artifacts"
          consumed={artifactConsumed}
          total={artifactTotal}
          formatValue={formatArtifactTokens}
        />
      ) : (
        <p className="text-ui-xs text-muted-foreground">
          Live artifact usage is unavailable.
        </p>
      )}
      {bundleTotal > 0 ? (
        <CreditMeterRow
          label="Bundle"
          consumed={bundleConsumed}
          total={bundleTotal}
          formatValue={formatCredits}
        />
      ) : null}
    </div>
  );
}

function CreditBreakdownView({
  breakdown,
}: {
  readonly breakdown: CreditBreakdown;
}): ReactNode {
  if (breakdown.totalAvailable <= 0) {
    return (
      <div className="text-ui-sm text-muted-foreground">
        No credit usage to display for this plan.
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {breakdown.planTotal > 0 ? (
        <CreditMeterRow
          label="Plan"
          consumed={breakdown.planConsumed}
          total={breakdown.planTotal}
          formatValue={formatCredits}
        />
      ) : null}
      {breakdown.bonusTotal > 0 ? (
        <CreditMeterRow
          label="Bonus"
          consumed={breakdown.bonusConsumed}
          total={breakdown.bonusTotal}
          formatValue={formatCredits}
        />
      ) : null}
      {breakdown.bundleTotal > 0 ? (
        <CreditMeterRow
          label="Bundle"
          consumed={breakdown.bundleConsumed}
          total={breakdown.bundleTotal}
          formatValue={formatCredits}
        />
      ) : null}
    </div>
  );
}

/**
 * A credit/balance meter row - matching the Codex/Claude window rows exactly:
 * "{label} · {percent}% used" over a muted amount line, with the same
 * severity-colored side bar from `window-severity.ts`, so Traycer's own bars
 * read identically to the other providers' (feedback: "bar similar to
 * claude/codex").
 */
function CreditMeterRow({
  label,
  consumed,
  total,
  formatValue,
}: {
  readonly label: string;
  readonly consumed: number;
  readonly total: number;
  readonly formatValue: (value: number) => string;
}): ReactNode {
  const usedPercent = total > 0 ? (consumed / total) * 100 : 0;
  const severity = rateLimitWindowSeverity(usedPercent);
  const fillPercent = rateLimitWindowFillPercent(usedPercent);
  return (
    <div className="flex items-center gap-2">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-ui-sm text-foreground">
          {label} · {Math.round(Math.min(100, Math.max(0, usedPercent)))}% used
        </span>
        <span className="text-ui-xs text-muted-foreground/70">
          {formatValue(consumed)} / {formatValue(total)}
        </span>
      </div>
      <div className="h-1.5 w-24 shrink-0 overflow-hidden rounded-full border border-border bg-muted">
        <div
          className={cn(
            "h-full rounded-full transition-all",
            rateLimitWindowSeverityBarClassName(severity),
          )}
          style={{ width: `${fillPercent}%` }}
        />
      </div>
    </div>
  );
}

/** Overrides the bar fill's default color - see `UsageBar`'s `tone` prop. */
export type UsageBarTone = "warning" | "critical";

function usageBarFillClassName(tone: UsageBarTone | undefined): string {
  if (tone === "critical") return "bg-destructive";
  if (tone === "warning") return "bg-amber-500 dark:bg-amber-400";
  return "bg-primary";
}

/**
 * Reusable consumed/total bar: a label + `format(consumed) / format(total)`
 * text row above a percent-fill track. Exported so other settings surfaces
 * (e.g. `provider-rate-limit-views.tsx`'s uncapped OpenRouter/Claude-extra-usage
 * bars) reuse the same bar chrome instead of building parallel markup.
 */
export function UsageBar({
  label,
  consumed,
  total,
  tone,
  formatValue,
}: {
  readonly label: string;
  readonly consumed: number;
  readonly total: number;
  // Overrides the fill color for callers with their own usage-severity
  // thresholds (e.g. rate-limit windows). `undefined` renders the default
  // primary color.
  readonly tone: UsageBarTone | undefined;
  readonly formatValue: (value: number) => string;
}): ReactNode {
  const percent = total > 0 ? Math.min(100, (consumed / total) * 100) : 0;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between text-ui-sm">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono text-ui-xs text-foreground">
          {formatValue(consumed)} / {formatValue(total)}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full transition-all",
            usageBarFillClassName(tone),
          )}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}
