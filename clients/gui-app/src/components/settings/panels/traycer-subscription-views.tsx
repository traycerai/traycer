/** Presentational, query-free views for the Traycer subscription surface. */
import type { ReactNode } from "react";
import type { TraycerTeamSubscription } from "@traycer/protocol/auth";
import type { AccountContext } from "@traycer/protocol/common/schemas";
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
  creditUsageSeverity,
  rateLimitWindowFillPercent,
  rateLimitWindowSeverityBarClassName,
  type RateLimitWindowSeverity,
} from "@/lib/rate-limits/window-severity";
import { cn } from "@/lib/utils";

/** Renders nothing when the user has no teams (the only choice is Personal, so a one-option select is noise) -
 * the caller can always render it unconditionally. */
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

/** The shared subscription body: either the credit breakdown (V3 credit plans) or the rate-limit view (legacy /
 * v2 plans) - now the single source both surfaces render through. */
export function TraycerSubscriptionView({
  subscription,
  accountContext,
}: {
  readonly subscription: TraycerSubscription;
  readonly accountContext: AccountContext;
}): ReactNode {
  const status = subscription.subscriptionStatus;
  return isCreditBasedPricing(status) ? (
    <CreditBreakdownView breakdown={creditBreakdown(subscription)} />
  ) : (
    <RateLimitView
      subscription={subscription}
      accountContext={accountContext}
    />
  );
}

// Rate-limit (legacy / v2) plans don't bill credits - they throttle artifact generation and refill at a
// recharge rate.
function RateLimitView({
  subscription,
  accountContext,
}: {
  readonly subscription: TraycerSubscription;
  readonly accountContext: AccountContext;
}) {
  const usageQuery = useHostRateLimitUsageQuery(accountContext, null);
  // Keep the bar live: a Traycer turn finishing while this is on screen
  // re-fetches usage. Only mounted here, so it costs nothing elsewhere.
  useRefreshRateLimitUsageOnTraycerTurn(accountContext);

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

/** The track fills with `bg-foreground/15` rather than `bg-muted`, and carries no border. */
export function MeterRow({
  label,
  usedPercent,
  detail,
  severity,
}: {
  readonly label: string;
  readonly usedPercent: number;
  readonly detail: ReactNode;
  readonly severity: RateLimitWindowSeverity;
}): ReactNode {
  const fillPercent = rateLimitWindowFillPercent(usedPercent);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-3 text-ui-sm">
        <span className="text-foreground">{label}</span>
        <span className="text-ui-xs text-muted-foreground/70">{detail}</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-foreground/15">
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

/** A credit/balance meter row - matching the Codex/Claude window rows exactly via the shared `MeterRow` shell,
 * so Traycer's own bars read identically to the other providers' (feedback: "bar similar to claude/codex"). */
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
  return (
    <MeterRow
      label={label}
      usedPercent={usedPercent}
      detail={`${formatValue(consumed)} / ${formatValue(total)}`}
      severity={creditUsageSeverity(usedPercent)}
    />
  );
}
