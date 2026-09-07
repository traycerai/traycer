/**
 * Host/query-free logic for the signed-in user's Traycer subscription + credits, shared by the Settings › Providers › Traycer card (`traycer-subscription-section.tsx`) and the header rate-limit popover's "Traycer" tab (`rate-limit-popover.tsx`) - mirroring.
 */
import type { AccountContext } from "@traycer/protocol/common/schemas";
import type {
  AuthenticatedUser,
  SubscriptionStatus,
  TraycerTeamSubscription,
  TraycerUserSubscription,
} from "@traycer/protocol/auth";
import { titleCaseFromToken } from "@/lib/provider-rate-limit-content";

/** The account-scoped subscription arms the account-context store can select between. */
export type TraycerSubscription =
  | TraycerUserSubscription
  | TraycerTeamSubscription;

export const PERSONAL_VALUE = "personal";
export const TEAM_VALUE_PREFIX = "team:";

export function isPaid(status: SubscriptionStatus): boolean {
  return status !== "FREE" && status !== "PENDING";
}

// V3 plans bill against credits; every other (legacy / v2) plan is rate-limit based.
// Ported from an internal shared package's `isCreditBasedPricing` (clients can't import that package).
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

export function isCreditBasedPricing(status: SubscriptionStatus): boolean {
  return CREDIT_BASED_STATUSES.has(status);
}

// A trailing `_V2`/`_V3` is an internal pricing-generation tag, not part of the plan's own identity - Cloud UI's own Settings pages never show it (billing-overview.tsx renders the Stripe product's bare name, e.g.
const VERSION_SUFFIX_PATTERN = /_V\d+$/;

// Every `SubscriptionStatus` this client's protocol version knows about maps to an exact label here.
// `Partial` (not a bare `Record`) so a status a *newer* backend added that this older client build doesn't know about yet (the protocol is versioned and runtime-negotiated - clients and the host ship independently) still falls through to.
const PLAN_LABELS: Partial<Record<SubscriptionStatus, string>> = {
  FREE: "BYOA",
  PENDING: "BYOA",
  BYOA_V3: "Sync",
  LITE_V3: "Lite",
  LITE_V2: "Lite (Legacy)",
  LITE: "Lite (Legacy)",
  PRO_V3: "Pro",
  PRO_V2: "Pro (Legacy)",
  PRO: "Pro (Legacy)",
  PRO_LEGACY: "Pro (Legacy)",
  PRO_PLUS: "Pro+ (Legacy)",
  PRO_PLUS_V2: "Pro+",
  ULTRA_1X_V3: "Ultra",
  ULTRA_2X_V3: "Ultra+",
  ULTRA_3X_V3: "Ultra+",
  ULTRA_4X_V3: "Ultra+",
  ULTRA_5X_V3: "Ultra+",
};

/**
 * The Traycer plan/tier label for the selected account (Core Flows parity with Codex/Claude: "shown where the provider reports one") - the header popover's "Traycer" tab shows this as a chip next to the name, same as `resolveProviderPlanLabel` does for the.
 */
export function subscriptionPlanLabel(status: SubscriptionStatus): string {
  return (
    PLAN_LABELS[status] ??
    titleCaseFromToken(String(status).replace(VERSION_SUFFIX_PATTERN, ""))
  );
}

/**
 * Whether the Traycer rail tab should appear at all: the resolved account is on a paid plan, or holds an active credit bundle.
 * Free/pending accounts with no bundle have nothing worth a dedicated tab.
 */
export function isTraycerEligible(subscription: TraycerSubscription): boolean {
  return (
    isPaid(subscription.subscriptionStatus) ||
    subscription.hasActiveBundle === true
  );
}

// Mirrors the extension's `formatRechargeRate`: minutes under a day, else days.
export function formatRechargeRate(rechargeRateSeconds: number): string | null {
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

// Picks the subscription for the resolved context: the user's own, or the
// matching team's. Null when the user isn't loaded or the team has no sub.
export function selectSubscription(
  user: AuthenticatedUser | null,
  resolved: AccountContext,
  teams: readonly TraycerTeamSubscription[],
): TraycerSubscription | null {
  if (user === null) return null;
  if (resolved.type === "PERSONAL") return user.userSubscription;
  return teams.find((t) => t.team.id === resolved.teamId) ?? null;
}

export function accountContextValue(context: AccountContext): string {
  return context.type === "PERSONAL"
    ? PERSONAL_VALUE
    : `${TEAM_VALUE_PREFIX}${context.teamId}`;
}

export function parseAccountContextValue(value: string): AccountContext {
  return value.startsWith(TEAM_VALUE_PREFIX)
    ? { type: "TEAM", teamId: value.slice(TEAM_VALUE_PREFIX.length) }
    : { type: "PERSONAL" };
}

// Artifact token counts aren't dollars - integers as-is, fractional usage to
// 3dp, mirroring the extension's `${consumed.toFixed(3)} / ${totalTokens}`.
export function formatArtifactTokens(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3);
}

// $-denominated credits. ponytail: 2dp currency rather than the extension's odd
// 3dp - decimals aren't part of the naming the user asked us to match.
export function formatCredits(value: number): string {
  return `$${value.toFixed(2)}`;
}

// Local mirror of the extension's `getCreditBreakdown` (the helper lives in an internal shared package, which clients can't import).
// Three buckets - Plan, Bonus, Bundle - tracked as consumed/total, matching the extension's wording.
export interface CreditBreakdown {
  readonly planTotal: number;
  readonly planConsumed: number;
  readonly bonusTotal: number;
  readonly bonusConsumed: number;
  readonly bundleTotal: number;
  readonly bundleConsumed: number;
  readonly totalAvailable: number;
  readonly totalConsumed: number;
}

export function creditBreakdown(
  subscription: TraycerSubscription,
): CreditBreakdown {
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

/**
 * The popover Traycer block's display state - the same cold/error/degraded shape the host-RPC providers use (`resolvePopoverProviderRateLimitState`), but keyed off the identity query (`useAuthUser`) rather than a per-provider host pull:
 */
export type TraycerSubscriptionState =
  | { readonly kind: "cold" }
  | { readonly kind: "error" }
  | { readonly kind: "empty" }
  | {
      readonly kind: "ready";
      readonly subscription: TraycerSubscription;
      readonly degraded: boolean;
    };

export function resolveTraycerSubscriptionState(args: {
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly subscription: TraycerSubscription | null;
}): TraycerSubscriptionState {
  if (args.subscription !== null) {
    return {
      kind: "ready",
      subscription: args.subscription,
      degraded: args.isError,
    };
  }
  if (args.isError) return { kind: "error" };
  if (args.isPending) return { kind: "cold" };
  return { kind: "empty" };
}
