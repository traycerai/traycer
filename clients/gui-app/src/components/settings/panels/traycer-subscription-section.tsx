/**
 * The signed-in user's Traycer subscription + credits, shown under the Traycer
 * provider. A global account-context selector (Personal / each Team) drives
 * which subscription is rendered. Data comes from `useAuthUser` (TanStack
 * Query) - never the auth store, which keeps only its narrow projections.
 */
import { ExternalLink } from "lucide-react";
import type { UseQueryResult } from "@tanstack/react-query";
import type {
  AuthenticatedUser,
  SubscriptionStatus,
  TraycerTeamSubscription,
  TraycerUserSubscription,
} from "@traycer/protocol/auth";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RefreshIconButton } from "@/components/refresh-icon-button";
import { resolveManageSubscriptionUrl } from "@/lib/auth/manage-subscription-url";
import { useAuthUser } from "@/hooks/auth/use-auth-user-query";
import { useRefreshCreditsOnTraycerTurn } from "@/hooks/auth/use-refresh-credits-on-traycer-turn";
import { useHostRateLimitUsageQuery } from "@/hooks/host/use-host-rate-limit-usage-query";
import { useRefreshRateLimitUsageOnTraycerTurn } from "@/hooks/host/use-refresh-rate-limit-usage-on-traycer-turn";
import { useRunnerHost } from "@/providers/use-runner-host";
import {
  resolveAccountContext,
  useAccountContextStore,
  type AccountContext,
} from "@/stores/auth/account-context-store";
import { cn } from "@/lib/utils";

const PERSONAL_VALUE = "personal";
const TEAM_VALUE_PREFIX = "team:";

// ponytail: hand-rolled label map - there's no shared SubscriptionStatus →
// display-name helper in the repo. Add tiers here as the enum grows.
const TIER_LABELS: Record<SubscriptionStatus, string> = {
  PENDING: "Pending",
  FREE: "Free",
  PRO_LEGACY: "Pro",
  PRO: "Pro",
  PRO_PLUS: "Pro Plus",
  LITE: "Lite",
  LITE_V2: "Lite",
  PRO_V2: "Pro",
  PRO_PLUS_V2: "Pro Plus",
  LITE_V3: "Lite",
  PRO_V3: "Pro",
  ULTRA_1X_V3: "Ultra 1x",
  ULTRA_2X_V3: "Ultra 2x",
  ULTRA_3X_V3: "Ultra 3x",
  ULTRA_4X_V3: "Ultra 4x",
  ULTRA_5X_V3: "Ultra 5x",
  BYOA_V3: "BYOA",
};

function isPaid(status: SubscriptionStatus): boolean {
  return status !== "FREE" && status !== "PENDING";
}

// V3 plans bill against credits; every other (legacy / v2) plan is rate-limit
// based. Ported from an internal shared package's `isCreditBasedPricing`
// (clients can't import that package). Credit plans → credit breakdown; the
// rest → rate limit.
const CREDIT_BASED_STATUSES: ReadonlySet<SubscriptionStatus> = new Set([
  "FREE",
  "LITE_V3",
  "PRO_V3",
  "ULTRA_1X_V3",
  "ULTRA_2X_V3",
  "ULTRA_3X_V3",
  "ULTRA_4X_V3",
  "ULTRA_5X_V3",
  "BYOA_V3",
]);

function isCreditBasedPricing(status: SubscriptionStatus): boolean {
  return CREDIT_BASED_STATUSES.has(status);
}

// Mirrors the extension's `formatRechargeRate`: minutes under a day, else days.
function formatRechargeRate(rechargeRateSeconds: number): string | null {
  if (rechargeRateSeconds <= 0) return null;
  const SECONDS_PER_DAY = 86_400;
  const SECONDS_PER_MINUTE = 60;
  if (rechargeRateSeconds < SECONDS_PER_DAY) {
    const minutes = Math.round(rechargeRateSeconds / SECONDS_PER_MINUTE);
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  }
  const days = Math.round(rechargeRateSeconds / SECONDS_PER_DAY);
  return `${days} ${days === 1 ? "day" : "days"}`;
}

type Subscription = TraycerUserSubscription | TraycerTeamSubscription;

// Picks the subscription for the resolved context: the user's own, or the
// matching team's. Null when the user isn't loaded or the team has no sub.
function selectSubscription(
  user: AuthenticatedUser | null,
  resolved: AccountContext,
  teams: readonly TraycerTeamSubscription[],
): Subscription | null {
  if (user === null) return null;
  if (resolved.type === "PERSONAL") return user.userSubscription;
  return teams.find((t) => t.team.id === resolved.teamId) ?? null;
}

function accountContextValue(context: AccountContext): string {
  return context.type === "PERSONAL"
    ? PERSONAL_VALUE
    : `${TEAM_VALUE_PREFIX}${context.teamId}`;
}

function parseAccountContextValue(value: string): AccountContext {
  return value.startsWith(TEAM_VALUE_PREFIX)
    ? { type: "TEAM", teamId: value.slice(TEAM_VALUE_PREFIX.length) }
    : { type: "PERSONAL" };
}

export function TraycerSubscriptionSection() {
  const query = useAuthUser();
  // Keep the balance live: a Traycer turn finishing while this card is open
  // refetches credits. Only mounted here, so it costs nothing elsewhere.
  useRefreshCreditsOnTraycerTurn();
  const runnerHost = useRunnerHost();
  const stored = useAccountContextStore((s) => s.accountContext);
  const setAccountContext = useAccountContextStore((s) => s.setAccountContext);

  const user = query.data ?? null;
  const teams = user?.teamSubscriptions ?? [];
  const teamIds = new Set(teams.map((t) => t.team.id));
  const resolved = resolveAccountContext(stored, teamIds);
  const subscription = selectSubscription(user, resolved, teams);

  const manageUrl = resolveManageSubscriptionUrl(runnerHost.authnBaseUrl);

  return (
    <div className="mb-3 flex flex-col gap-3 rounded-lg border border-border/60 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-ui-sm font-medium text-foreground">
          Subscription
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => {
              void runnerHost.openExternalLink(manageUrl);
            }}
            className="inline-flex w-fit items-center gap-1.5 rounded px-1 text-ui-xs font-medium text-primary transition-colors hover:text-primary/80 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            Manage subscription
            <ExternalLink className="size-3" />
          </button>
          <RefreshIconButton
            onRefresh={async () => {
              await query.refetch();
            }}
            label="Refresh subscription"
            refreshing={query.isFetching}
          />
        </div>
      </div>

      {teams.length > 0 ? (
        <Select
          value={accountContextValue(resolved)}
          onValueChange={(value) =>
            setAccountContext(parseAccountContextValue(value))
          }
        >
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
      ) : null}

      <SubscriptionBody query={query} subscription={subscription} />
    </div>
  );
}

function SubscriptionBody({
  query,
  subscription,
}: {
  readonly query: UseQueryResult<AuthenticatedUser | null>;
  readonly subscription: Subscription | null;
}) {
  if (query.isPending) {
    return (
      <div className="flex items-center gap-2 text-ui-sm text-muted-foreground">
        <MutedAgentSpinner /> Loading subscription
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className="text-ui-sm text-destructive">
        Couldn't load your subscription. Try refreshing.
      </div>
    );
  }
  if (subscription === null) {
    return (
      <div className="text-ui-sm text-muted-foreground">
        No subscription found for this account.
      </div>
    );
  }
  return <SubscriptionDetail subscription={subscription} />;
}

function SubscriptionDetail({
  subscription,
}: {
  readonly subscription: Subscription;
}) {
  const status = subscription.subscriptionStatus;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={isPaid(status) ? "default" : "secondary"}>
          {TIER_LABELS[status]}
        </Badge>
        {subscription.isInTrial ? <Badge variant="outline">Trial</Badge> : null}
      </div>

      {isCreditBasedPricing(status) ? (
        <CreditBreakdownView breakdown={creditBreakdown(subscription)} />
      ) : (
        <RateLimitView subscription={subscription} />
      )}
    </div>
  );
}

// Artifact token counts aren't dollars - integers as-is, fractional usage to
// 3dp, mirroring the extension's `${consumed.toFixed(3)} / ${totalTokens}`.
function formatArtifactTokens(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3);
}

// Rate-limit (legacy / v2) plans don't bill credits - they throttle artifact
// generation and refill at a recharge rate. Mirrors the extension's
// `RateLimitBasedPlanUsageDisplay` (recharge rate + artifact bar + bundle bar).
// Live artifact usage comes from aperture via `host.getRateLimitUsage`; when
// aperture is off or has no data (totalTokens === 0) we show "unavailable"
// rather than a 0-left bar (decision 2).
function RateLimitView({
  subscription,
}: {
  readonly subscription: Subscription;
}) {
  const usageQuery = useHostRateLimitUsageQuery();
  // Keep the bar live: a Traycer turn finishing while this card is open
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
        <UsageBar
          label="Artifacts"
          consumed={artifactConsumed}
          total={artifactTotal}
          tone={undefined}
          formatValue={formatArtifactTokens}
        />
      ) : (
        <p className="text-ui-xs text-muted-foreground">
          Live artifact usage is unavailable.
        </p>
      )}
      {bundleTotal > 0 ? (
        <UsageBar
          label="Bundle"
          consumed={bundleConsumed}
          total={bundleTotal}
          tone={undefined}
        />
      ) : null}
    </div>
  );
}

// Local mirror of the extension's `getCreditBreakdown` (the helper lives in
// an internal shared package, which clients can't import). Three buckets -
// Plan, Bonus, Bundle - tracked as consumed/total, matching the extension's
// wording.
interface CreditBreakdown {
  readonly planTotal: number;
  readonly planConsumed: number;
  readonly bonusTotal: number;
  readonly bonusConsumed: number;
  readonly bundleTotal: number;
  readonly bundleConsumed: number;
  readonly totalAvailable: number;
  readonly totalConsumed: number;
}

function creditBreakdown(subscription: Subscription): CreditBreakdown {
  const credit = subscription.credit;
  const planTotal = subscription.totalPlanCredits ?? 0;
  const planRemaining = Math.max(
    0,
    planTotal - (credit?.consumedFromPlan ?? 0),
  );
  const planConsumed = Math.max(0, planTotal - planRemaining);
  const bonusTotal = credit?.bonusCredits ?? 0;
  const bonusConsumed = credit?.consumedFromBonus ?? 0;
  const bundleTotal = subscription.bundleSummary?.bundleTotal ?? 0;
  const bundleRemaining = subscription.bundleSummary?.bundleRemaining ?? 0;
  const bundleConsumed = Math.max(0, bundleTotal - bundleRemaining);
  return {
    planTotal,
    planConsumed,
    bonusTotal,
    bonusConsumed,
    bundleTotal,
    bundleConsumed,
    totalAvailable: planTotal + bonusTotal + bundleTotal,
    totalConsumed: planConsumed + bonusConsumed + bundleConsumed,
  };
}

// $-denominated credits. ponytail: 2dp currency rather than the extension's odd
// 3dp - decimals aren't part of the naming the user asked us to match.
function formatCredits(value: number): string {
  return `$${value.toFixed(2)}`;
}

function usageColor(percentUsed: number, bonusInUse: boolean): string {
  if (percentUsed < 50) return "text-green-500";
  if (percentUsed < 90) return bonusInUse ? "text-blue-500" : "text-yellow-500";
  return "text-red-500";
}

function CreditBreakdownView({
  breakdown,
}: {
  readonly breakdown: CreditBreakdown;
}) {
  if (breakdown.totalAvailable <= 0) {
    return (
      <div className="text-ui-sm text-muted-foreground">
        No credit usage to display for this plan.
      </div>
    );
  }
  const percentUsed = Math.min(
    100,
    (breakdown.totalConsumed / breakdown.totalAvailable) * 100,
  );
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-ui-sm font-medium text-foreground">
          Credit breakdown
        </span>
        <span
          className={cn(
            "text-ui-xs font-medium",
            usageColor(percentUsed, breakdown.bonusConsumed > 0),
          )}
        >
          {percentUsed.toFixed(0)}% used
        </span>
      </div>
      {breakdown.planTotal > 0 ? (
        <UsageBar
          label="Plan"
          consumed={breakdown.planConsumed}
          total={breakdown.planTotal}
          tone={undefined}
        />
      ) : null}
      {breakdown.bonusTotal > 0 ? (
        <UsageBar
          label="Bonus"
          consumed={breakdown.bonusConsumed}
          total={breakdown.bonusTotal}
          accent
          tone={undefined}
        />
      ) : null}
      {breakdown.bundleTotal > 0 ? (
        <UsageBar
          label="Bundle"
          consumed={breakdown.bundleConsumed}
          total={breakdown.bundleTotal}
          tone={undefined}
        />
      ) : null}
    </div>
  );
}

/** Overrides the bar fill's default color - see `UsageBar`'s `tone` prop. */
export type UsageBarTone = "warning" | "critical";

function usageBarFillClassName(
  accent: boolean | undefined,
  tone: UsageBarTone | undefined,
): string {
  if (tone === "critical") return "bg-destructive";
  if (tone === "warning") return "bg-amber-500 dark:bg-amber-400";
  return accent ? "bg-blue-400" : "bg-primary";
}

/**
 * Reusable consumed/total bar: a label + `format(consumed) / format(total)`
 * text row above a percent-fill track. Exported so other settings surfaces
 * (e.g. `provider-rate-limit-views.tsx`) reuse the same bar chrome instead of
 * building parallel markup - the whole point of matching this card's design
 * language.
 */
export function UsageBar({
  label,
  consumed,
  total,
  accent,
  tone,
  formatValue,
}: {
  readonly label: string;
  readonly consumed: number;
  readonly total: number;
  readonly accent?: boolean;
  // Overrides the fill color regardless of `accent` - callers with their own
  // usage-severity thresholds (e.g. rate-limit windows) pass this instead of
  // the default primary/accent color. `undefined` for callers (the credit
  // and bundle bars here) that don't want severity-based coloring.
  readonly tone: UsageBarTone | undefined;
  // Defaults to $-denominated credits; artifact bars pass a token formatter.
  readonly formatValue?: (value: number) => string;
}) {
  const format = formatValue ?? formatCredits;
  const percent = total > 0 ? Math.min(100, (consumed / total) * 100) : 0;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between text-ui-sm">
        <span
          className={cn("text-muted-foreground", accent && "text-blue-400")}
        >
          {label}
        </span>
        <span className="font-mono text-ui-xs text-foreground">
          {format(consumed)} / {format(total)}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full transition-all",
            usageBarFillClassName(accent, tone),
          )}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}
