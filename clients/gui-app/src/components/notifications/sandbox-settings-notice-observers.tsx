import { useEffect, useState, type ReactNode } from "react";
import type { SandboxSummary } from "@traycer/protocol/host/sandbox-control";
import type { EnvironmentStatusResponseV11 } from "@traycer/protocol/host/environment-schemas";
import { sandboxSettingsReady } from "@traycer/protocol/host/sandbox-settings";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostCapabilityProbe } from "@/hooks/host/use-host-capability-probe";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { sandboxListReadSentAt } from "@/hooks/sandboxes/use-sandbox-list-query";
import { useSandboxNoticeListQuery } from "@/components/notifications/use-sandbox-notice-list-query";
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
  const list = useSandboxNoticeListQuery(true);
  const noticesBySandbox = new Map<string, SettingsNotice[]>();
  for (const notice of props.notices) {
    const notices = noticesBySandbox.get(notice.sandboxId);
    if (notices === undefined) {
      noticesBySandbox.set(notice.sandboxId, [notice]);
    } else {
      notices.push(notice);
    }
  }
  const sentAt = list.isSuccess ? sandboxListReadSentAt(list.data) : null;
  return [...noticesBySandbox].map(([sandboxId, notices]) => (
    <SettingsNoticeObserver
      key={sandboxId}
      notices={notices}
      summary={
        list.isSuccess
          ? (list.data?.sandboxes.find((row) => row.id === sandboxId) ?? null)
          : null
      }
      sentAt={sentAt}
    />
  ));
}

function SettingsNoticeObserver(props: {
  readonly notices: readonly SettingsNotice[];
  readonly summary: SandboxSummary | null;
  /** When the list read the summary came from was sent; null when unknown. */
  readonly sentAt: number | null;
}): null {
  const status = useNoticeSettingsStatus(props.summary);
  const actions = useMergedNotificationsActions();
  const state = props.summary?.state ?? null;
  useEffect(() => {
    if (props.sentAt !== null && settingsNoticeHostGone(state)) {
      for (const notice of props.notices) {
        // An older list answer cannot retire a failure written after it.
        if (props.sentAt >= notice.row.createdAt) {
          actions.retireNotice(notice.row);
        }
      }
      return;
    }
    if (props.summary?.guestConfigured === true && status.isSuccess) {
      for (const notice of props.notices) {
        if (settingsNoticeApplied(status.data, notice.operationId)) {
          actions.retireNotice(notice.row);
        }
      }
    }
  }, [
    actions,
    props.notices,
    props.sentAt,
    props.summary?.guestConfigured,
    state,
    status.data,
    status.isSuccess,
  ]);
  return null;
}

/**
 * A sandbox that suspended, stopped or was destroyed can no longer apply the
 * settings: its failure notices retire. The list is visibility-filtered, so
 * an absent row proves nothing and keeps them.
 */
function settingsNoticeHostGone(
  state: SandboxSummary["state"] | null,
): boolean {
  return state === "suspended" || state === "stopped" || state === "destroyed";
}

/** One receipt per sandbox episode, shared by every warning for that sandbox. */
function useNoticeSettingsStatus(sandbox: SandboxSummary | null) {
  const hostId = sandbox?.hostId ?? null;
  const client = useHostClientForHostId(hostId);
  const host = useHostDirectoryEntry(hostId);
  const awake = sandbox?.state === "awake";
  const identity = JSON.stringify([
    noticeSettingsRowEpisode(sandbox),
    hostId,
    host?.websocketUrl,
    host?.version,
    host?.transportDialability,
    client?.getRequestContextUserId(),
  ]);
  const [episode, setEpisode] = useState(() => ({ identity, generation: 0 }));
  let current = episode;
  if (episode.identity !== identity) {
    current = { identity, generation: episode.generation + 1 };
    setEpisode(current);
  }
  // The generation fences a return to earlier row values before cache GC.
  // Notice arrivals do not change this identity: an attempt is immutable.
  const cacheIdentity = [
    "sandbox-settings-notices",
    identity,
    current.generation,
  ];
  const supported = useHostMethodSupport(hostId, "environment.status");
  useHostCapabilityProbe({
    client,
    stale: awake && hostId !== null && supported !== true,
    incarnation: cacheIdentity,
  });
  return useHostQuery<HostRpcRegistry, "environment.status">({
    cacheKeyIdentity: cacheIdentity,
    client,
    method: "environment.status",
    params: {},
    options: {
      enabled: awake && hostId !== null && supported === true,
      poll: false,
      staleTime: Infinity,
      gcTime: 0,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    },
  });
}

/** List activity and other sandboxes cannot invalidate this sandbox's receipt. */
function noticeSettingsRowEpisode(
  sandbox: SandboxSummary | null,
): readonly unknown[] | null {
  if (sandbox === null) return null;
  return [
    sandbox.id,
    sandbox.state,
    sandbox.lastTransitionAt,
    sandbox.guestConfigured,
    sandbox.guestConfigFailureReason,
    sandbox.phase,
    sandbox.routes,
    sandbox.environmentId,
    sandbox.operation?.at,
    sandbox.operation?.state,
  ];
}

function settingsNoticeApplied(
  status: EnvironmentStatusResponseV11,
  operationId: string,
): boolean {
  if (
    status.reachability !== "connected" ||
    status.principal === null ||
    status.receivedRevision === null ||
    status.sandboxSettingsOperationId !== operationId
  )
    return false;
  return sandboxSettingsReady(status.items);
}
