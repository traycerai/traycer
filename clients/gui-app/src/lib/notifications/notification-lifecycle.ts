import type { HostNotificationSeverity } from "@traycer/protocol/host/notifications/contracts";
import type { MergedNotificationSource } from "@/stores/notifications/merged-notifications";

/**
 * Attention's classes, in order: prompts that block, failures, then a bot's
 * answers to the person, which need them without anything having gone wrong.
 */
export type NotificationAttentionTier = "blocking" | "failure" | "answer";

export interface NotificationLifecycleInput {
  readonly source: MergedNotificationSource;
  readonly severity: HostNotificationSeverity;
  readonly readAt: number | null;
  /** A bot's answer to the person (`isBotThreadVerdictNotification`). */
  readonly botAnswer?: boolean;
}

export type NotificationLifecycleClassification =
  | { readonly section: "attention"; readonly tier: NotificationAttentionTier }
  | { readonly section: "recent" };

/**
 * The single lifecycle classifier: every feed row belongs to Attention or
 * Recent, never both. Attention membership is unread host prompts,
 * unread host failures, unread app-local failures and unread bot answers, as
 * the hosts' summaries count them. Collaboration rows are never
 * attention-eligible.
 */
export function classifyNotificationLifecycle(
  row: NotificationLifecycleInput,
): NotificationLifecycleClassification {
  if (row.source === "global") return { section: "recent" };
  if (row.severity === "needs_action") {
    return row.readAt === null
      ? { section: "attention", tier: "blocking" }
      : { section: "recent" };
  }
  if (row.severity === "failure") {
    return row.readAt === null
      ? { section: "attention", tier: "failure" }
      : { section: "recent" };
  }
  if (row.botAnswer === true && row.readAt === null) {
    return { section: "attention", tier: "answer" };
  }
  return { section: "recent" };
}

const ATTENTION_TIER_ORDER: Readonly<
  Record<NotificationAttentionTier, number>
> = {
  blocking: 0,
  failure: 1,
  answer: 2,
};

export interface AttentionOrderCandidate {
  readonly tier: NotificationAttentionTier;
  readonly createdAt: number;
  readonly feedId: string;
}

/** Deterministic byte-order ascending comparison, matching SQLite's `id ASC`
 * tie-break - never locale-sensitive, so ordering can't drift by ICU version
 * or system locale. */
export function compareFeedIdAscending(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Negative when tier `a` lists before tier `b`. */
export function compareAttentionTiers(
  a: NotificationAttentionTier,
  b: NotificationAttentionTier,
): number {
  return ATTENTION_TIER_ORDER[a] - ATTENTION_TIER_ORDER[b];
}

/** Blocking prompts, then failures, then answers; newest first within each
 * tier; a stable `feedId` tie-break so equal timestamps still order
 * deterministically. */
export function compareAttentionOrder(
  a: AttentionOrderCandidate,
  b: AttentionOrderCandidate,
): number {
  const tierDelta = compareAttentionTiers(a.tier, b.tier);
  if (tierDelta !== 0) return tierDelta;
  const createdAtDelta = b.createdAt - a.createdAt;
  if (createdAtDelta !== 0) return createdAtDelta;
  return compareFeedIdAscending(a.feedId, b.feedId);
}
