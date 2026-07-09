import { useMemo } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { useHostBinding, type HostRpcRegistry } from "@/lib/host";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { notificationsMutationKeys } from "@/lib/query-keys";
import { toastFromHostError } from "@/lib/host-error-toast";
import {
  buildPayloadFromEvent,
  parseNotificationPayload,
  type NotificationPayload,
} from "@/lib/notifications";
import {
  useAppLocalNotificationById,
  useAppLocalNotificationIds,
  useAppLocalNotificationUnreadCount,
  useAppLocalNotificationsStore,
  type AppLocalNotificationEntry,
} from "@/stores/notifications/app-local-notifications-store";
import {
  selectHostNotificationNextCursor,
  useHostNotificationById,
  useHostNotificationIds,
  useHostNotificationUnreadCount,
  useHostNotificationsStore,
} from "@/stores/notifications/host-notifications-store";
import {
  useNotificationEntryById,
  useNotificationEntryIds,
  useNotificationUnreadCount,
  useNotificationsStore,
} from "@/stores/notifications/notifications-store";
import type { HostNotificationEntry } from "@traycer/protocol/host/notifications/contracts";
import type { NotificationEntry } from "@traycer/protocol/notifications/notification-entry";
import { formatNotification } from "@traycer/protocol/notifications/notification-formatter";

export type MergedNotificationSource = "host" | "app-local" | "global";

export interface MergedNotificationRow {
  readonly feedId: string;
  readonly source: MergedNotificationSource;
  readonly sourceId: string;
  readonly createdAt: number;
  readonly readAt: number | null;
  readonly text: string;
  readonly payload: NotificationPayload | null;
  readonly hostKind: HostNotificationEntry["kind"] | null;
  readonly appLocalKind: AppLocalNotificationEntry["kind"] | null;
  readonly globalEntry: NotificationEntry | null;
}

export interface MergedNotificationsActions {
  readonly markAsRead: (feedId: string) => void;
  readonly markAllAsRead: () => void;
  readonly clearAll: () => void;
  readonly loadMoreHost: () => void;
  readonly canLoadMoreHost: boolean;
  readonly isLoadingMoreHost: boolean;
}

interface FeedCandidate {
  readonly feedId: string;
  readonly createdAt: number;
}

interface ParsedFeedId {
  readonly source: MergedNotificationSource;
  readonly sourceId: string;
}

interface HostNotificationMutationContext {
  readonly hostId: string | null;
  readonly snapshotEpoch: number;
}

export function hostFeedId(id: string): string {
  return `host:${id}`;
}

export function globalFeedId(id: string): string {
  return `global:${id}`;
}

export function appLocalFeedId(id: string): string {
  return `app-local:${id}`;
}

export function mergeNotificationFeedIds(
  hostEntries: ReadonlyArray<HostNotificationEntry>,
  appLocalEntries: ReadonlyArray<FeedCandidate>,
  globalEntries: ReadonlyArray<NotificationEntry>,
): ReadonlyArray<string> {
  const candidates: FeedCandidate[] = [
    ...hostEntries.map((entry) => ({
      feedId: hostFeedId(entry.id),
      createdAt: entry.updatedAt,
    })),
    ...appLocalEntries,
    ...globalEntries.map((entry) => ({
      feedId: globalFeedId(entry.id),
      createdAt: entry.createdAt,
    })),
  ];
  candidates.sort((a, b) => {
    const createdAtDelta = b.createdAt - a.createdAt;
    if (createdAtDelta !== 0) return createdAtDelta;
    return b.feedId.localeCompare(a.feedId);
  });
  return candidates.map((candidate) => candidate.feedId);
}

export function mergedUnreadCount(input: {
  readonly hostUnread: number;
  readonly appLocalUnread: number;
  readonly globalUnread: number;
}): number {
  return input.hostUnread + input.appLocalUnread + input.globalUnread;
}

export function useMergedNotificationIds(): ReadonlyArray<string> {
  const hostIds = useHostNotificationIds();
  const appLocalIds = useAppLocalNotificationIds();
  const globalIds = useNotificationEntryIds();
  const hostById = useHostNotificationsStore((state) => state.byId);
  const appLocalById = useAppLocalNotificationsStore((state) => state.byId);
  return useMemo(() => {
    const hostEntries = hostIds.map((id) => hostById[id]);
    const globalEntries = useNotificationsStore.getState().entries;
    const globalEntriesById = new Map(
      globalEntries.map((entry) => [entry.id, entry]),
    );
    const orderedGlobalEntries = globalIds
      .map((id) => globalEntriesById.get(id))
      .filter((entry): entry is NotificationEntry => entry !== undefined);
    const appLocalEntries = appLocalIds
      .map((id) => appLocalById[id])
      .map((entry) => ({
        feedId: appLocalFeedId(entry.id),
        createdAt: entry.updatedAt,
      }));
    return mergeNotificationFeedIds(
      hostEntries,
      appLocalEntries,
      orderedGlobalEntries,
    );
  }, [hostIds, hostById, appLocalIds, appLocalById, globalIds]);
}

export function useMergedNotificationRow(
  feedId: string,
): MergedNotificationRow | null {
  const parsed = parseFeedId(feedId);
  const hostEntry = useHostNotificationById(
    parsed?.source === "host" ? parsed.sourceId : "",
  );
  const appLocalEntry = useAppLocalNotificationById(
    parsed?.source === "app-local" ? parsed.sourceId : "",
  );
  const globalEntry = useNotificationEntryById(
    parsed?.source === "global" ? parsed.sourceId : "",
  );
  if (parsed === null) return null;
  if (parsed.source === "host") {
    return hostEntry === null ? null : rowFromHostEntry(hostEntry);
  }
  if (parsed.source === "app-local") {
    return appLocalEntry === null ? null : rowFromAppLocalEntry(appLocalEntry);
  }
  return globalEntry === null ? null : rowFromGlobalEntry(globalEntry);
}

export function useMergedNotificationUnreadCount(): number {
  const hostUnread = useHostNotificationUnreadCount();
  const appLocalUnread = useAppLocalNotificationUnreadCount();
  const globalUnread = useNotificationUnreadCount();
  return mergedUnreadCount({
    hostUnread,
    appLocalUnread,
    globalUnread,
  });
}

export function useMergedNotificationsActions(): MergedNotificationsActions {
  const binding = useHostBinding();
  const client = binding?.hostClient ?? null;
  const globalMarkAsRead = useNotificationsStore((state) => state.markAsRead);
  const globalMarkAllAsRead = useNotificationsStore(
    (state) => state.markAllAsRead,
  );
  const globalClearAll = useNotificationsStore((state) => state.clearAll);
  const appLocalMarkAsRead = useAppLocalNotificationsStore(
    (state) => state.markAsRead,
  );
  const appLocalMarkAllAsRead = useAppLocalNotificationsStore(
    (state) => state.markAllAsRead,
  );
  const appLocalClearAll = useAppLocalNotificationsStore(
    (state) => state.clearAll,
  );
  const hostNextCursor = useHostNotificationsStore(
    selectHostNotificationNextCursor,
  );

  const markHostRead = useHostMutation<
    HostRpcRegistry,
    "host.notifications.markRead",
    HostNotificationMutationContext,
    { readonly feedId: string; readonly sourceId: string }
  >({
    client,
    method: "host.notifications.markRead",
    mapVariables: (variables) => ({ ids: [variables.sourceId] }),
    options: {
      mutationKey: notificationsMutationKeys.markRead(),
      onMutate: () => captureHostNotificationMutationContext(client),
      onSuccess: (_data, variables, context) => {
        if (!isCurrentHostNotificationMutation(client, context)) return;
        useHostNotificationsStore
          .getState()
          .applyReadState(
            [variables.sourceId],
            Date.now(),
            context.snapshotEpoch,
          );
      },
      onError: (error, _variables, context) => {
        if (!isCurrentHostNotificationMutation(client, context)) return;
        toastFromHostError(error, "Couldn't mark the notification as read.");
      },
    },
  });

  const markHostAllRead = useHostMutation<
    HostRpcRegistry,
    "host.notifications.markAllRead",
    HostNotificationMutationContext,
    { readonly beforeUpdatedAt: number }
  >({
    client,
    method: "host.notifications.markAllRead",
    mapVariables: (variables) => ({
      beforeUpdatedAt: variables.beforeUpdatedAt,
    }),
    options: {
      mutationKey: notificationsMutationKeys.markAllRead(),
      onMutate: () => captureHostNotificationMutationContext(client),
      onSuccess: (_data, variables, context) => {
        if (!isCurrentHostNotificationMutation(client, context)) return;
        useHostNotificationsStore
          .getState()
          .markAllReadLocally(
            variables.beforeUpdatedAt,
            Date.now(),
            context.snapshotEpoch,
          );
      },
      onError: (error, _variables, context) => {
        if (!isCurrentHostNotificationMutation(client, context)) return;
        toastFromHostError(error, "Couldn't mark notifications as read.");
      },
    },
  });

  const loadMoreHost = useHostMutation<
    HostRpcRegistry,
    "host.notifications.list",
    HostNotificationMutationContext,
    { readonly cursor: NonNullable<typeof hostNextCursor> }
  >({
    client,
    method: "host.notifications.list",
    mapVariables: (variables) => ({
      filter: "all",
      limit: HOST_PAGE_LIMIT,
      cursor: variables.cursor,
    }),
    options: {
      mutationKey: notificationsMutationKeys.loadMore(),
      onMutate: () => captureHostNotificationMutationContext(client),
      onSuccess: (data, _variables, context) => {
        if (!isCurrentHostNotificationMutation(client, context)) return;
        useHostNotificationsStore
          .getState()
          .mergePage(data.entries, data.nextCursor, context.snapshotEpoch);
      },
      onError: (error, _variables, context) => {
        if (!isCurrentHostNotificationMutation(client, context)) return;
        toastFromHostError(error, "Couldn't load older notifications.");
      },
    },
  });

  return useMemo(
    () => ({
      markAsRead: (feedId) => {
        const parsed = parseFeedId(feedId);
        if (parsed === null) return;
        if (parsed.source === "host") {
          if (client === null) return;
          markHostRead.mutate({
            feedId,
            sourceId: parsed.sourceId,
          });
          return;
        }
        if (parsed.source === "global") {
          globalMarkAsRead(parsed.sourceId);
          return;
        }
        appLocalMarkAsRead(parsed.sourceId, Date.now());
      },
      markAllAsRead: () => {
        globalMarkAllAsRead();
        appLocalMarkAllAsRead(Date.now());
        if (client !== null) {
          markHostAllRead.mutate({ beforeUpdatedAt: Date.now() });
        }
      },
      clearAll: () => {
        globalClearAll();
        appLocalClearAll();
      },
      loadMoreHost: () => {
        if (hostNextCursor === null || client === null) return;
        loadMoreHost.mutate({ cursor: hostNextCursor });
      },
      canLoadMoreHost: hostNextCursor !== null && client !== null,
      isLoadingMoreHost: loadMoreHost.isPending,
    }),
    [
      globalMarkAsRead,
      globalMarkAllAsRead,
      globalClearAll,
      appLocalMarkAsRead,
      appLocalMarkAllAsRead,
      appLocalClearAll,
      markHostRead,
      markHostAllRead,
      loadMoreHost,
      hostNextCursor,
      client,
    ],
  );
}

export function rowFromHostEntry(
  entry: HostNotificationEntry,
): MergedNotificationRow {
  return {
    feedId: hostFeedId(entry.id),
    source: "host",
    sourceId: entry.id,
    createdAt: entry.updatedAt,
    readAt: entry.readAt,
    text: formatHostNotification(entry),
    payload: payloadFromHostEntry(entry),
    hostKind: entry.kind,
    appLocalKind: null,
    globalEntry: null,
  };
}

export function rowFromAppLocalEntry(
  entry: AppLocalNotificationEntry,
): MergedNotificationRow {
  return {
    feedId: appLocalFeedId(entry.id),
    source: "app-local",
    sourceId: entry.id,
    createdAt: entry.updatedAt,
    readAt: entry.readAt,
    text:
      entry.detail === null
        ? entry.message
        : `${entry.message} ${entry.detail}`,
    payload: entry.payload,
    hostKind: null,
    appLocalKind: entry.kind,
    globalEntry: null,
  };
}

export function rowFromGlobalEntry(
  entry: NotificationEntry,
): MergedNotificationRow {
  return {
    feedId: globalFeedId(entry.id),
    source: "global",
    sourceId: entry.id,
    createdAt: entry.createdAt,
    readAt: entry.readAt,
    text: formatNotification(entry.event, undefined),
    payload: buildPayloadFromEvent(entry.event),
    hostKind: null,
    appLocalKind: null,
    globalEntry: entry,
  };
}

function parseFeedId(feedId: string): ParsedFeedId | null {
  const delimiterIndex = feedId.indexOf(":");
  if (delimiterIndex <= 0) return null;
  const source = feedId.slice(0, delimiterIndex);
  const sourceId = feedId.slice(delimiterIndex + 1);
  if (sourceId.length === 0) return null;
  if (source === "host" || source === "app-local" || source === "global") {
    return { source, sourceId };
  }
  return null;
}

function captureHostNotificationMutationContext(
  client: HostClient<HostRpcRegistry> | null,
): HostNotificationMutationContext {
  return {
    hostId: client?.getActiveHostId() ?? null,
    snapshotEpoch: useHostNotificationsStore.getState().snapshotEpoch,
  };
}

function isCurrentHostNotificationMutation(
  client: HostClient<HostRpcRegistry> | null,
  context: HostNotificationMutationContext | undefined,
): context is HostNotificationMutationContext {
  if (context === undefined) return false;
  if (
    useHostNotificationsStore.getState().snapshotEpoch !== context.snapshotEpoch
  ) {
    return false;
  }
  return (client?.getActiveHostId() ?? null) === context.hostId;
}

function payloadFromHostEntry(
  entry: HostNotificationEntry,
): NotificationPayload | null {
  const parsed = parseNotificationPayload(entry.payload);
  if (parsed !== null) return parsed;
  const epicId = readPayloadString(entry.payload, "epicId");
  const chatId = readPayloadString(entry.payload, "chatId");
  if (epicId === null || chatId === null) return null;
  if (entry.kind === "approval.requested") {
    return {
      kind: "approval",
      epicId,
      chatId,
      approvalId: readPayloadString(entry.payload, "approvalId") ?? undefined,
      sessionId: undefined,
      artifactId: undefined,
    };
  }
  if (entry.kind === "interview.requested") {
    return {
      kind: "interview",
      epicId,
      chatId,
      interviewBlockId:
        readPayloadString(entry.payload, "interviewBlockId") ?? undefined,
    };
  }
  return { kind: "chat", epicId, chatId };
}

function formatHostNotification(entry: HostNotificationEntry): string {
  const agentName = readPayloadString(entry.payload, "agentName");
  const chatTitle = readPayloadString(entry.payload, "chatTitle");
  switch (entry.kind) {
    case "agent.stopped":
      return agentName === null ? "Agent finished" : `${agentName} finished`;
    case "approval.requested":
      return chatTitle === null
        ? "Approval requested"
        : `Approval requested in ${chatTitle}`;
    case "interview.requested":
      return chatTitle === null
        ? "Question waiting"
        : `Question waiting in ${chatTitle}`;
  }
}

function readPayloadString(
  payload: HostNotificationEntry["payload"],
  key: string,
): string | null {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

const HOST_PAGE_LIMIT = 50;
