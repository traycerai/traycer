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
  return [...noticesBySandbox].map(([sandboxId, notices]) => (
    <SettingsNoticeObserver
      key={sandboxId}
      notices={notices}
      summary={
        list.isSuccess
          ? (list.data?.sandboxes.find((row) => row.id === sandboxId) ?? null)
          : null
      }
    />
  ));
}

function SettingsNoticeObserver(props: {
  readonly notices: readonly SettingsNotice[];
  readonly summary: SandboxSummary | null;
}): null {
  const status = useNoticeSettingsStatus(props.summary);
  const actions = useMergedNotificationsActions();
  useEffect(() => {
    if (props.summary?.guestConfigured === true && status.isSuccess) {
      for (const notice of props.notices) {
        if (settingsNoticeApplied(status.data, notice.operationId)) {
          actions.resolveNotice(notice.row);
        }
      }
    }
  }, [
    actions,
    props.notices,
    props.summary?.guestConfigured,
    status.data,
    status.isSuccess,
  ]);
  return null;
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
