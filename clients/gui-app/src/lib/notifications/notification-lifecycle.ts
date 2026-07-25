import type { HostNotificationSeverity } from "@traycer/protocol/host/notifications/contracts";
import type { MergedNotificationSource } from "@/stores/notifications/merged-notifications";

export type NotificationAttentionTier = "blocking" | "failure";

export interface NotificationLifecycleInput {
  readonly source: MergedNotificationSource;
  readonly severity: HostNotificationSeverity;
  readonly readAt: number | null;
  /** Only host approval/interview rows carry a meaningful value; every other
   * row passes `null`, which never satisfies the unresolved-prompt branch. */
  readonly resolvedAt: number | null;
}

export type NotificationLifecycleClassification =
  | { readonly section: "attention"; readonly tier: NotificationAttentionTier }
  | { readonly section: "recent" };

/**
 * The single lifecycle classifier: every feed row belongs to Attention or
 * Recent, never both. Attention membership is unresolved host prompts,
 * unread host failures, and unread app-local failures - collaboration rows
 * are never attention-eligible.
 */
export function classifyNotificationLifecycle(
  row: NotificationLifecycleInput,
): NotificationLifecycleClassification {
  if (row.source === "global") return { section: "recent" };
  if (row.severity === "needs_action") {
    return row.resolvedAt === null
      ? { section: "attention", tier: "blocking" }
      : { section: "recent" };
  }
  if (row.severity === "failure") {
    return row.readAt === null
      ? { section: "attention", tier: "failure" }
      : { section: "recent" };
  }
  return { section: "recent" };
}

const ATTENTION_TIER_ORDER: Readonly<
  Record<NotificationAttentionTier, number>
> = {
  blocking: 0,
  failure: 1,
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

/** Blocking prompts before failures; newest first within each tier; a
 * stable `feedId` tie-break so equal timestamps still order deterministically. */
export function compareAttentionOrder(
  a: AttentionOrderCandidate,
  b: AttentionOrderCandidate,
): number {
  const tierDelta = ATTENTION_TIER_ORDER[a.tier] - ATTENTION_TIER_ORDER[b.tier];
  if (tierDelta !== 0) return tierDelta;
  const createdAtDelta = b.createdAt - a.createdAt;
  if (createdAtDelta !== 0) return createdAtDelta;
  return compareFeedIdAscending(a.feedId, b.feedId);
}
