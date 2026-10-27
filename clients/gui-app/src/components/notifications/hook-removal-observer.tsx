import { filterConsumedHookRemovalNotices } from "@/lib/notifications/hook-removal-notices";
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  hasBorrowableRemoteSession,
  subscribeRemoteSessionReadiness,
  tryAcquireReadyRemoteSession,
} from "@traycer-clients/shared/host-transport/remote/index";
import type {
  NotificationHooksRemovalNotice,
  NotificationHooksStatusResponse,
} from "@traycer/protocol/host/notifications/host-notifications";
import { notificationHooksRemovedMessage } from "@traycer/protocol/host/notifications/presentation";
import { useHostDirectoryList } from "@/hooks/host/use-host-directory-list-query";
import { useNotificationHooksStatusForClient } from "@/hooks/host/use-notification-hooks-query";
import type { HostRpcRegistry } from "@/lib/host";
import {
  routeNotificationForHost,
  type NotificationNavigate,
} from "@/lib/notifications";
import { hostQueryKeys } from "@/lib/query-keys";

const EMPTY_NOTICES: readonly NotificationHooksRemovalNotice[] = [];

/** Pending receipts are visible on connection even before the origin store can
 * publish. Desktop delivery still belongs to the ordinary notification event. */
export function HookRemovalObserver(props: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly navigate: NotificationNavigate;
}) {
  const status = useNotificationHooksStatusForClient(props.client);
  return (
    <HookRemovalAnnouncements
      notices={status.data?.pendingRemovalNotices ?? EMPTY_NOTICES}
      navigate={props.navigate}
    />
  );
}

function HookRemovalAnnouncements(props: {
  readonly notices: readonly NotificationHooksRemovalNotice[];
  readonly navigate: NotificationNavigate;
}) {
  const shown = useRef(new Set<string>());
  useEffect(() => {
    const current = new Set<string>();
    for (const notice of props.notices) {
      // The eventual published entry uses the same toast key and updates this
      // message rather than creating another foreground announcement.
      const key = `host:id:${notice.id}`;
      current.add(key);
      if (shown.current.has(key)) continue;
      shown.current.add(key);
      toast("Notification hooks removed", {
        id: key,
        description: notificationHooksRemovedMessage(
          notice.hostName,
          notice.count,
        ),
        duration: Infinity,
        action: {
          label: "Review hooks",
          onClick: () => {
            routeNotificationForHost(
              props.navigate,
              {
                kind: "hostSurface",
                surface: "notificationSettings",
                hostId: notice.hostId,
                focus: undefined,
              },
              notice.occurredAt,
              { originHostId: notice.hostId, effectiveHostId: null },
            );
          },
        },
      });
    }
    for (const key of shown.current) {
      if (current.has(key)) continue;
      toast.dismiss(key);
      shown.current.delete(key);
    }
  }, [props.notices, props.navigate]);
  useEffect(() => {
    const active = shown.current;
    return () => {
      for (const key of active) toast.dismiss(key);
    };
  }, []);
  return null;
}

/** Observe hosts the user already connected to, without dialing the fleet. */
export function ConnectedHookRemovalObservers(props: {
  readonly servingHostId: string | null;
  readonly navigate: NotificationNavigate;
}) {
  const directory = useHostDirectoryList();
  const idsKey = (directory.data ?? [])
    .map((host) => host.hostId)
    .filter((hostId) => hostId !== props.servingHostId)
    .sort()
    .join("\n");
  const getSnapshot = useCallback(
    () =>
      idsKey
        .split("\n")
        .filter(
          (hostId) => hostId.length > 0 && hasBorrowableRemoteSession(hostId),
        )
        .join("\n"),
    [idsKey],
  );
  const connected = useSyncExternalStore(
    subscribeRemoteSessionReadiness,
    getSnapshot,
    getSnapshot,
  );
  return (
    <>
      {connected
        .split("\n")
        .filter((hostId) => hostId.length > 0)
        .map((hostId) => (
          <ConnectedHookRemovalObserver
            key={hostId}
            hostId={hostId}
            navigate={props.navigate}
          />
        ))}
    </>
  );
}

function ConnectedHookRemovalObserver(props: {
  readonly hostId: string;
  readonly navigate: NotificationNavigate;
}) {
  const queryClient = useQueryClient();
  const status = useQuery(
    queryOptions({
      queryKey: hostQueryKeys.notificationHookRemovalBorrowedStatus(
        props.hostId,
      ),
      queryFn: ({ signal }) => readBorrowedHookStatus(props.hostId, signal),
      select: (response) =>
        filterConsumedHookRemovalNotices(response, queryClient, props.hostId),
      retry: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    }),
  );
  return (
    <HookRemovalAnnouncements
      notices={status.data?.pendingRemovalNotices ?? EMPTY_NOTICES}
      navigate={props.navigate}
    />
  );
}

/** Borrowing cannot create or prolong a session, including a disconnect
 * between the observer render and query dispatch. */
async function readBorrowedHookStatus(
  hostId: string,
  signal: AbortSignal,
): Promise<NotificationHooksStatusResponse> {
  const borrowed = tryAcquireReadyRemoteSession<HostRpcRegistry>(hostId);
  if (borrowed === null) throw new Error("Computer is no longer connected.");
  try {
    return await borrowed.sendUnary(
      "host.notificationHooks.status",
      {},
      signal,
      undefined,
    );
  } finally {
    borrowed.release();
  }
}
