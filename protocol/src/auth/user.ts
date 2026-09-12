/**
 * Auth / session enum + non-record helper types owned by
 * `@traycer/protocol`.
 *
 * Types backed by a registered Zod schema (`User`, `Organization`,
 * `Team`, `Subscription`, `Credit`, `BundleSummary`, `PayAsYouGoUsage`,
 * `AuthenticatedUser`, `LegacyAuthenticatedUser`,
 * `ProviderLoginResponse`, `ValidateCouponResponse`, `EmailOtpResponse`)
 * are derived from the registered schemas via `RecordValue<>` and
 * exported from `protocol/auth/registry.ts`. The runtime schemas live
 * under `protocol/auth/_internal/schemas.ts` and are reachable only
 * through `getRecordSchema(authRecordRegistry, "<record-name>")`.
 *
 * What stays here:
 *
 * - String-literal enums (`ProviderType`, `SeatAllocation`,
 *   `SubscriptionStatus`, `UserSource`) embedded inside the records.
 * - Non-record extension shapes (`AuthenticatedUserBase`,
 *   `OrganizationCredit`, `TraycerOrganizationSubscription`,
 *   `TraycerUserSubscription`, `TraycerTeamSubscription`) - Zod schemas
 *   exist for these in `_internal/schemas.ts` but they are not
 *   independent records, so the inferred TypeScript shape lives here
 *   alongside the enums it composes against.
 *
 * Billing / pricing DTOs (Stripe) and cloud-only helpers
 * (UserOrganizations, GitHubUser, and the broader organization /
 * team / seat surface) intentionally stay outside this module and
 * live with the authn service in an internal shared package (not in
 * this repo).
 */
import type {
  BundleSummary,
  Credit,
  Organization,
  PayAsYouGoUsage,
  Subscription,
  Team,
  User,
} from "./registry";

export type ProviderType = "GITHUB" | "GOOGLE" | "GITLAB" | "EMAIL";

export type SeatAllocation = "MANUAL" | "AUTO_ALLOCATION";

export type SubscriptionStatus =
  | "PENDING"
  | "FREE"
  | "PRO_LEGACY"
  | "PRO"
  | "PRO_PLUS"
  | "LITE"
  | "LITE_V2"
  | "PRO_V2"
  | "PRO_PLUS_V2"
  | "LITE_V3"
  | "PRO_V3"
  | "ULTRA_1X_V3"
  | "ULTRA_2X_V3"
  | "ULTRA_3X_V3"
  | "ULTRA_4X_V3"
  | "ULTRA_5X_V3"
  | "BYOA_V3";

// ponytail: explicit deny-list — a new SubscriptionStatus value defaults to
// "paid", matching product intent that only FREE/PENDING are unpaid.
export const isPaidTier = (s: SubscriptionStatus): boolean =>
  s !== "FREE" && s !== "PENDING";

export enum UserSource {
  VSCODE_EXTENSION = "VSCODE_EXTENSION",
  CLOUD_UI = "CLOUD_UI",
}

// ---- Non-record extension types (no independent registry entry) -------- //

export interface OrganizationCredit extends Credit {
  orgId: string;
}

export interface TraycerOrganizationSubscription extends Subscription {
  organization?: Organization;
  isInTrial: boolean;
  bundleSummary?: BundleSummary;
  credit?: OrganizationCredit;
  totalPlanCredits?: number;
  rechargeRateSeconds: number;
  hasActiveBundle?: boolean;
}

export interface TraycerUserSubscription extends Subscription {
  isInTrial: boolean;
  bundleSummary?: BundleSummary;
  credit?: Credit;
  totalPlanCredits?: number;
  rechargeRateSeconds: number;
  hasActiveBundle?: boolean;
}

export interface TraycerTeamSubscription extends Subscription {
  team: Team;
  isInTrial: boolean;
  bundleSummary: BundleSummary;
  credit?: OrganizationCredit;
  totalPlanCredits: number;
  rechargeRateSeconds: number;
  hasActiveBundle: boolean;
}

export interface AuthenticatedUserBase {
  user: User;
  userSubscription: TraycerUserSubscription;
  payAsYouGoUsage: PayAsYouGoUsage;
}
