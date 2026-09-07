/**
 * Auth enums and non-record extension shapes. Registered record types come from `protocol/auth/registry.ts`.
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

// ponytail: explicit deny-list - a new SubscriptionStatus value defaults to
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
