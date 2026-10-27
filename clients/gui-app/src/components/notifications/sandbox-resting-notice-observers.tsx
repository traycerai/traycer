import { useEffect, type ReactNode } from "react";
import type { SandboxSummary } from "@traycer/protocol/host/sandbox-control";
import { sandboxListReadSentAt } from "@/hooks/sandboxes/use-sandbox-list-query";
import { useSandboxNoticeListQuery } from "@/components/notifications/use-sandbox-notice-list-query";
import {
  useMergedNotificationRows,
  useMergedNotificationsActions,
  type MergedNotificationRow,
} from "@/stores/notifications/merged-notifications";

interface RestingNotice {
  readonly row: MergedNotificationRow;
  readonly sandboxId: string;
  readonly destroyAt: number;
  readonly restingSince: number;
}

/** Rebuild retirement from current list evidence even when a relay omits resolvedAt. */
export function SandboxRestingNoticeObservers(): ReactNode {
  const rows = useMergedNotificationRows();
  const notices: RestingNotice[] = [];
  for (const row of rows) {
    const sandbox = row.sandboxNotice;
    if (
      row.source !== "cloud" ||
      row.severity !== "needs_action" ||
      row.resolvedAt !== null ||
      sandbox?.notice.kind !== "resting_warning"
    )
      continue;
    notices.push({
      row,
      sandboxId: sandbox.sandboxId,
      destroyAt: sandbox.notice.destroyAt,
      restingSince:
        sandbox.notice.destroyAt - sandbox.notice.periodMinutes * 60_000,
    });
  }
  return notices.length === 0 ? null : (
    <ActiveRestingNotices notices={notices} />
  );
}

function ActiveRestingNotices(props: {
  readonly notices: readonly RestingNotice[];
}): null {
  const list = useSandboxNoticeListQuery(true);
  const actions = useMergedNotificationsActions();
  useEffect(() => {
    if (!list.isEnabled || !list.isSuccess) return;
    const sentAt = sandboxListReadSentAt(list.data);
    if (sentAt === null) return;
    const summaries = new Map<string, SandboxSummary>();
    for (const sandbox of list.data?.sandboxes ?? []) {
      summaries.set(sandbox.id, sandbox);
    }
    for (const notice of props.notices) {
      // An older cached awake answer cannot retire a later resting warning.
      if (sentAt < notice.row.createdAt) continue;
      const summary = summaries.get(notice.sandboxId);
      // The list is visibility-filtered: an absent row is not proof of deletion.
      if (summary !== undefined && restingNoticeOvertaken(summary, notice)) {
        actions.resolveNotice(notice.row);
      }
    }
  }, [actions, props.notices, list.data, list.isEnabled, list.isSuccess]);
  return null;
}

function restingNoticeOvertaken(
  summary: SandboxSummary,
  notice: RestingNotice,
): boolean {
  if (summary.state === "awake" || summary.state === "destroyed") return true;
  if (summary.state !== "suspended" && summary.state !== "stopped")
    return false;
  // Older list servers omit these clocks. Only a known changed clock proves
  // this is a different rest; unknown clocks keep the warning actionable.
  return (
    (summary.destroyAt !== null && summary.destroyAt !== notice.destroyAt) ||
    (summary.restingSince !== null &&
      summary.restingSince !== notice.restingSince)
  );
}
