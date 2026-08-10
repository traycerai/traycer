import type {
  HostNotificationEntry,
  HostNotificationsCloudFeedRow,
  HostNotificationsEntityRef,
  HostNotificationsIndicatorState,
  HostNotificationsIndicatorStateResponse,
} from "@traycer/protocol/host/notifications/contracts";
import {
  notificationPayloadBelongsToEntity,
  notificationPayloadBelongsToEpic,
} from "@/lib/notifications";
import {
  useAppLocalNotificationsStore,
  type AppLocalNotificationsState,
} from "@/stores/notifications/app-local-notifications-store";

export interface NotificationIndicatorState {
  readonly unreadFailure: boolean;
  readonly pendingApproval: boolean;
  readonly pendingInterview: boolean;
  readonly unreadDone: boolean;
}

export const EMPTY_NOTIFICATION_INDICATOR_STATE: NotificationIndicatorState = {
  unreadFailure: false,
  pendingApproval: false,
  pendingInterview: false,
  unreadDone: false,
};

const EMPTY_HOST_INDICATOR_STATE = EMPTY_NOTIFICATION_INDICATOR_STATE;

export function selectNotificationIndicatorState(
  state: Pick<AppLocalNotificationsState, "byId">,
  entity: HostNotificationsEntityRef,
  indicators: HostNotificationsIndicatorStateResponse,
): NotificationIndicatorState {
  const hostState =
    entity.chatId === undefined
      ? (indicators.epics[entity.epicId] ?? EMPTY_HOST_INDICATOR_STATE)
      : (indicators.chats[entity.chatId] ?? EMPTY_HOST_INDICATOR_STATE);
  const unreadLocalFailure = Object.values(state.byId).some(
    (entry) =>
      entry.readAt === null &&
      (entity.chatId === undefined
        ? notificationPayloadBelongsToEpic(entry.payload, entity.epicId)
        : notificationPayloadBelongsToEntity(entry.payload, entity)),
  );
  if (!unreadLocalFailure && hostState === EMPTY_HOST_INDICATOR_STATE) {
    return EMPTY_NOTIFICATION_INDICATOR_STATE;
  }
  return {
    unreadFailure: unreadLocalFailure || hostState.unreadFailure,
    pendingApproval: hostState.pendingApproval,
    pendingInterview: hostState.pendingInterview,
    unreadDone: hostState.unreadDone,
  };
}

export function useNotificationIndicatorState(
  entity: HostNotificationsEntityRef,
  indicators: HostNotificationsIndicatorStateResponse,
): NotificationIndicatorState {
  const byId = useAppLocalNotificationsStore((state) => state.byId);
  return selectNotificationIndicatorState({ byId }, entity, indicators);
}

export const EMPTY_INDICATOR_STATE_RESPONSE: HostNotificationsIndicatorStateResponse =
  { epics: {}, chats: {} };

/**
 * The cloud-mode counterpart of the host's `indicatorState` RPC, computed from
 * the snapshot the GUI already holds.
 *
 * The cloud feed is the complete VISIBLE set (the relay only ever sends whole
 * snapshots, already filtered for cleared/superseded), and every row carries
 * the entity columns, severity, kind and markers - so the four predicates are
 * exactly the host's, evaluated over rows from EVERY host rather than only the
 * connected one. Ported verbatim from
 * `hostNotificationsGetIndicatorState`: an epic aggregates all of its rows
 * including its chats', a chat aggregates only its own, and pending is
 * `resolvedAt === null` on the two request kinds.
 *
 * Sparse on purpose: an entity with nothing lit is omitted, which
 * `selectNotificationIndicatorState`'s `?? EMPTY` lookup reads identically to
 * the host's all-false row while keeping the empty result referentially
 * stable.
 */
export function selectCloudNotificationIndicators(
  rows: Readonly<Partial<Record<string, HostNotificationsCloudFeedRow>>>,
  epicIds: ReadonlyArray<string>,
  chatIds: ReadonlyArray<string>,
): HostNotificationsIndicatorStateResponse {
  const wantedEpicIds = new Set(epicIds);
  const wantedChatIds = new Set(chatIds);
  if (wantedEpicIds.size === 0 && wantedChatIds.size === 0) {
    return EMPTY_INDICATOR_STATE_RESPONSE;
  }
  const epics: Record<string, HostNotificationsIndicatorState> = {};
  const chats: Record<string, HostNotificationsIndicatorState> = {};
  for (const row of Object.values(rows)) {
    if (row === undefined) continue;
    const contribution = indicatorContribution(row.entry);
    if (contribution === null) continue;
    const { epicId, chatId } = row.entry;
    if (epicId !== null && wantedEpicIds.has(epicId)) {
      epics[epicId] = mergeIndicatorFlags(epics[epicId], contribution);
    }
    if (chatId !== null && wantedChatIds.has(chatId)) {
      chats[chatId] = mergeIndicatorFlags(chats[chatId], contribution);
    }
  }
  return { epics, chats };
}

/** `null` when the entry lights nothing, so an entity with only quiet rows is
 * never allocated an all-false record. */
function indicatorContribution(
  entry: HostNotificationEntry,
): HostNotificationsIndicatorState | null {
  const pendingApproval =
    entry.kind === "approval.requested" && entry.resolvedAt === null;
  const pendingInterview =
    entry.kind === "interview.requested" && entry.resolvedAt === null;
  const unreadFailure = entry.severity === "failure" && entry.readAt === null;
  const unreadDone = entry.severity === "done" && entry.readAt === null;
  if (!pendingApproval && !pendingInterview && !unreadFailure && !unreadDone) {
    return null;
  }
  return { pendingApproval, pendingInterview, unreadFailure, unreadDone };
}

/** The host's `MAX(CASE WHEN ...)` aggregate: any contributing row lights the
 * entity's flag. */
function mergeIndicatorFlags(
  current: HostNotificationsIndicatorState | undefined,
  next: HostNotificationsIndicatorState,
): HostNotificationsIndicatorState {
  if (current === undefined) return next;
  return {
    pendingApproval: current.pendingApproval || next.pendingApproval,
    pendingInterview: current.pendingInterview || next.pendingInterview,
    unreadFailure: current.unreadFailure || next.unreadFailure,
    unreadDone: current.unreadDone || next.unreadDone,
  };
}
