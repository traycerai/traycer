import type {
  HostNotificationSeverity,
  HostNotificationSandboxNoticePayload,
  HostNotificationKind,
} from "@traycer/protocol/host/notifications/contracts";
import type { MergedNotificationSource } from "@/stores/notifications/merged-notifications";
import type { EnvironmentNotificationDetail } from "@/lib/notifications/environment-notification-detail";

/**
 * Attention's classes, in order: prompts that block, failures, then a bot's
 * answers to the person, which need them without anything having gone wrong.
 */
export type NotificationAttentionTier = "blocking" | "failure" | "answer";

export interface NotificationLifecycleInput {
  readonly source: MergedNotificationSource;
  readonly severity: HostNotificationSeverity;
  readonly readAt: number | null;
  /** Resolution is independent of read acknowledgement on actionable notices. */
  readonly resolvedAt: number | null;
  readonly hostKind?: HostNotificationKind | null;
  readonly sandboxNotice?: HostNotificationSandboxNoticePayload | null;
  readonly environmentDetail?: EnvironmentNotificationDetail | null;
  /** A bot's answer to the person (`isBotThreadVerdictNotification`). */
  readonly botAnswer?: boolean;
}

export type NotificationLifecycleClassification =
  | { readonly section: "attention"; readonly tier: NotificationAttentionTier }
  | { readonly section: "recent" };

/** Reading does not complete a notice's action. Details-only apply failures
 * instead use the ordinary acknowledgement lifecycle. */
export function isActionableNotice(row: NotificationLifecycleInput): boolean {
  return (
    row.severity === "needs_action" &&
    ((row.sandboxNotice ?? null) !== null ||
      (row.hostKind === "environment.apply.failed" &&
        row.environmentDetail?.kind === "environment_apply_failed" &&
        (row.environmentDetail.sandbox ?? null) !== null))
  );
}

/**
 * A resolved actionable notice is retired: it leaves the bell, Recent
 * included, and the outcome notice or the wake is its trace. Rows an older
 * writer only resolved are retired here too.
 */
export function isRetiredNotice(row: NotificationLifecycleInput): boolean {
  return isActionableNotice(row) && row.resolvedAt !== null;
}

/**
 * The single lifecycle classifier: every feed row belongs to Attention or
 * Recent, never both. Attention membership is unread host prompts,
 * unread host failures, unread app-local failures, unresolved actionable
 * notices and unread bot answers, as the hosts' summaries count them.
 * Collaboration rows are never attention-eligible. A retired notice
 * ({@link isRetiredNotice}) is in neither: the merged rows drop it.
 */
export function classifyNotificationLifecycle(
  row: NotificationLifecycleInput,
): NotificationLifecycleClassification {
  if (row.source === "global") return { section: "recent" };
  if (isActionableNotice(row)) {
    return row.resolvedAt === null
      ? { section: "attention", tier: "blocking" }
      : { section: "recent" };
  }
  if (row.severity === "needs_action") {
    const tier =
      row.hostKind === "environment.apply.failed" ? "failure" : "blocking";
    return row.readAt === null
      ? { section: "attention", tier }
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
