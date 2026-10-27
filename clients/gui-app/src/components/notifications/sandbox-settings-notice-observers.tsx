import { useEffect, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { SandboxSummary } from "@traycer/protocol/host/sandbox-control";
import type { EnvironmentStatusResponseV11 } from "@traycer/protocol/host/environment-schemas";
import { sandboxSettingsReady } from "@traycer/protocol/host/sandbox-settings";
import { useHostBinding } from "@/lib/host";
import { useSandboxSettingsStatus } from "@/hooks/sandboxes/use-sandbox-settings-status";
import { sandboxListQueryOptions } from "@/hooks/sandboxes/use-sandbox-list-query";
import { useSandboxControlUnavailableReason } from "@/hooks/sandboxes/use-sandbox-control-unavailable-reason";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  useMergedNotificationRows,
  useMergedNotificationsActions,
  type MergedNotificationRow,
} from "@/stores/notifications/merged-notifications";

interface SettingsNotice {
  readonly row: MergedNotificationRow;
  readonly sandboxId: string;
  readonly operationId: string;
}

/** The root keeps these observers alive while the notification center is closed. */
export function SandboxSettingsNoticeObservers(): ReactNode {
  const rows = useMergedNotificationRows();
  const notices: SettingsNotice[] = [];
  for (const row of rows) {
    if (
      row.source !== "cloud" ||
      row.severity !== "needs_action" ||
      row.resolvedAt !== null ||
      row.environmentDetail?.kind !== "environment_apply_failed"
    )
      continue;
    const sandbox = row.environmentDetail.sandbox;
    if (
      typeof sandbox?.sandboxId === "string" &&
      typeof sandbox.operationId === "string"
    ) {
      notices.push({
        row,
        sandboxId: sandbox.sandboxId,
        operationId: sandbox.operationId,
      });
    }
  }
  return notices.length === 0 ? null : (
    <ActiveSettingsNotices notices={notices} />
  );
}

/** Share the row's existing list cache, reading it only while a warning needs evidence. */
function ActiveSettingsNotices(props: {
  readonly notices: readonly SettingsNotice[];
}): ReactNode {
  const binding = useHostBinding();
  const signedIn = useAuthStore((state) => state.status === "signed-in");
  const userId = useAuthStore((state) => state.contextMetadata?.userId ?? null);
  const available = useSandboxControlUnavailableReason() === null;
  const list = useQuery(
    sandboxListQueryOptions(
      binding?.auth ?? null,
      userId,
      signedIn && available,
    ),
  );
  return props.notices.map((notice) => (
    <SettingsNoticeObserver
      key={`${notice.row.feedId}:${notice.operationId}`}
      notice={notice}
      summary={
        list.isSuccess
          ? (list.data?.sandboxes.find((row) => row.id === notice.sandboxId) ??
            null)
          : null
      }
    />
  ));
}

function SettingsNoticeObserver(props: {
  readonly notice: SettingsNotice;
  readonly summary: SandboxSummary | null;
}): null {
  const status = useSandboxSettingsStatus(props.summary);
  const actions = useMergedNotificationsActions();
  useEffect(() => {
    if (
      props.summary?.guestConfigured === true &&
      status.isSuccess &&
      settingsNoticeOvertaken(status.data, props.notice.operationId)
    ) {
      actions.resolveNotice(props.notice.row);
    }
  }, [
    actions,
    props.notice,
    props.summary?.guestConfigured,
    status.data,
    status.isSuccess,
  ]);
  return null;
}

function settingsNoticeOvertaken(
  status: EnvironmentStatusResponseV11,
  operationId: string,
): boolean {
  if (
    status.reachability !== "connected" ||
    status.principal === null ||
    status.receivedRevision === null ||
    typeof status.sandboxSettingsOperationId !== "string"
  )
    return false;
  if (sandboxSettingsReady(status.items)) return true;
  // A different, settled attempt replaces this warning. Pending, unknown or
  // offline evidence cannot establish that a later attempt has finished.
  return (
    status.sandboxSettingsOperationId !== operationId &&
    status.items.every(
      (item) =>
        item.status === "applied" ||
        item.status === "not_used" ||
        item.status === "failed" ||
        item.status === "unsupported",
    )
  );
}
