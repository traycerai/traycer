import { useMemo } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { v4 as uuidv4 } from "uuid";
import type { FatalErrorDetails } from "@traycer/protocol/framework/ws-protocol";
import type { NotificationPayload } from "@/lib/notifications";
import {
  notificationPayloadBelongsToEntity,
  parseNotificationPayload,
} from "@/lib/notifications";
import { appLocalNotificationsKey, basePersistOptions } from "@/lib/persist";
import type { HostNotificationsEntityRef } from "@traycer/protocol/host/notifications/contracts";

type TerminalNotificationTarget = Extract<
  NotificationPayload,
  { readonly kind: "terminal" }
>;

export const APP_LOCAL_NOTIFICATIONS_ROW_CAP = 200;

/**
 * How long a read cause-keyed entry stays acknowledged before a recurrence
 * of the same cause flips it back to unread. Caps badge churn from a
 * high-frequency failure at one unread-flip per window while still
 * re-surfacing a problem the user acknowledged but that keeps happening.
 */
export const APP_LOCAL_RESURFACE_COOLDOWN_MS = 5 * 60_000;

export type AppLocalNotificationKind =
  | "terminal.closed"
  | "terminal.crashed"
  | "stream.transport.error"
  | "host.error";

export interface AppLocalNotificationEntry {
  readonly id: string;
  readonly updatedAt: number;
  readonly readAt: number | null;
  readonly kind: AppLocalNotificationKind;
  readonly sourceRef: string | null;
  readonly payload: NotificationPayload | null;
  readonly message: string;
  readonly detail: string | null;
}

interface AppLocalNotificationsProjection {
  readonly orderedIds: ReadonlyArray<string>;
  readonly unreadCount: number;
}

export interface AppLocalNotificationsState {
  readonly activeUserId: string | null;
  readonly byId: Readonly<Record<string, AppLocalNotificationEntry>>;
  readonly orderedIds: ReadonlyArray<string>;
  readonly unreadCount: number;

  activateIdentity: (userId: string) => void;
  deactivateIdentity: () => void;
  upsert: (entry: AppLocalNotificationEntry) => void;
  upsertReplacing: (entry: AppLocalNotificationEntry) => void;
  upsertReplacingPreservingReadState: (
    entry: AppLocalNotificationEntry,
  ) => void;
  markAsRead: (id: string, readAt: number) => void;
  markEntityAsRead: (
    entity: HostNotificationsEntityRef,
    readAt: number,
  ) => void;
  markAllAsRead: (readAt: number) => void;
  clearAll: () => void;
  resetForTests: () => void;
}

function appLocalInitialState(): Pick<
  AppLocalNotificationsState,
  "activeUserId" | "byId" | "orderedIds" | "unreadCount"
> {
  return {
    activeUserId: null,
    byId: {},
    orderedIds: [],
    unreadCount: 0,
  };
}

function projectAppLocalNotifications(
  byId: Readonly<Record<string, AppLocalNotificationEntry>>,
): AppLocalNotificationsProjection {
  const entries = Object.values(byId);
  entries.sort(compareAppLocalNotificationEntries);
  return {
    orderedIds: entries.map((entry) => entry.id),
    unreadCount: entries.filter((entry) => entry.readAt === null).length,
  };
}

export function compareAppLocalNotificationEntries(
  a: AppLocalNotificationEntry,
  b: AppLocalNotificationEntry,
): number {
  const updatedAtDelta = b.updatedAt - a.updatedAt;
  if (updatedAtDelta !== 0) return updatedAtDelta;
  return b.id.localeCompare(a.id);
}

function cappedAppLocalEntries(
  byId: Readonly<Record<string, AppLocalNotificationEntry>>,
): Readonly<Record<string, AppLocalNotificationEntry>> {
  const entries = Object.values(byId).sort(compareAppLocalNotificationEntries);
  if (entries.length <= APP_LOCAL_NOTIFICATIONS_ROW_CAP) return byId;
  return Object.fromEntries(
    entries
      .slice(0, APP_LOCAL_NOTIFICATIONS_ROW_CAP)
      .map((entry) => [entry.id, entry]),
  );
}

type AppLocalNotificationsPersistedState = Pick<
  AppLocalNotificationsState,
  "byId" | "orderedIds" | "unreadCount"
>;

/**
 * v1 -> v2 migration. Workspace failures now live in the host-owned durable
 * feed, so retaining their old localStorage rows would duplicate the migrated
 * notification after upgrade. Rebuild the persisted projection while dropping
 * only that retired kind; malformed legacy rows are discarded defensively.
 */
export function migrateAppLocalNotificationsPersistedState(
  persisted: unknown,
): AppLocalNotificationsPersistedState {
  if (!isRecord(persisted) || !isRecord(persisted.byId)) {
    return { byId: {}, orderedIds: [], unreadCount: 0 };
  }
  const byId = Object.fromEntries(
    Object.entries(persisted.byId)
      .map(([id, value]) => parsePersistedAppLocalEntry(id, value))
      .filter((entry): entry is AppLocalNotificationEntry => entry !== null)
      .map((entry) => [entry.id, entry]),
  );
  const projection = projectAppLocalNotifications(byId);
  return {
    byId,
    orderedIds: projection.orderedIds,
    unreadCount: projection.unreadCount,
  };
}

function parsePersistedAppLocalEntry(
  id: string,
  value: unknown,
): AppLocalNotificationEntry | null {
  if (!isRecord(value) || !isAppLocalNotificationKind(value.kind)) {
    return null;
  }
  if (
    typeof value.updatedAt !== "number" ||
    !Number.isFinite(value.updatedAt) ||
    (value.readAt !== null &&
      (typeof value.readAt !== "number" || !Number.isFinite(value.readAt))) ||
    (value.sourceRef !== null && typeof value.sourceRef !== "string") ||
    typeof value.message !== "string" ||
    (value.detail !== null && typeof value.detail !== "string")
  ) {
    return null;
  }
  return {
    id,
    updatedAt: value.updatedAt,
    readAt: value.readAt,
    kind: value.kind,
    sourceRef: value.sourceRef,
    payload: parseNotificationPayload(value.payload),
    message: value.message,
    detail: value.detail,
  };
}

function isAppLocalNotificationKind(
  value: unknown,
): value is AppLocalNotificationKind {
  return (
    value === "terminal.closed" ||
    value === "terminal.crashed" ||
    value === "stream.transport.error" ||
    value === "host.error"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

export function createAppLocalNotificationsStore(initialName: string) {
  return create<AppLocalNotificationsState>()(
    persist(
      (set, get) => ({
        ...appLocalInitialState(),

        activateIdentity: (userId) => {
          set({ activeUserId: userId });
        },

        deactivateIdentity: () => {
          set(appLocalInitialState());
        },

        upsert: (entry) => {
          if (get().activeUserId === null) return;
          if (Object.hasOwn(get().byId, entry.id)) return;
          set((state) => {
            const byId = cappedAppLocalEntries({
              ...state.byId,
              [entry.id]: entry,
            });
            const projection = projectAppLocalNotifications(byId);
            return {
              byId,
              orderedIds: projection.orderedIds,
              unreadCount: projection.unreadCount,
            };
          });
        },

        // For cause-keyed entries (recurring host errors): replaces the
        // existing row so the single entry carries the latest occurrence -
        // fresh timestamp, latest detail - instead of either stacking
        // duplicates or (like `upsert`) silently dropping every recurrence
        // after the first, which a persisted store would otherwise do
        // forever. A recurrence flips the row back to unread only when the
        // user's read-acknowledgement is older than the resurface cooldown;
        // a cause firing every few seconds must not re-light the badge as
        // fast as it fires.
        upsertReplacing: (entry) => {
          if (get().activeUserId === null) return;
          set((state) => {
            const existing = Object.hasOwn(state.byId, entry.id)
              ? state.byId[entry.id]
              : null;
            const acknowledged =
              existing !== null &&
              existing.readAt !== null &&
              entry.updatedAt - existing.readAt <
                APP_LOCAL_RESURFACE_COOLDOWN_MS;
            const byId = cappedAppLocalEntries({
              ...state.byId,
              [entry.id]: acknowledged
                ? { ...entry, readAt: existing.readAt }
                : entry,
            });
            const projection = projectAppLocalNotifications(byId);
            return {
              byId,
              orderedIds: projection.orderedIds,
              unreadCount: projection.unreadCount,
            };
          });
        },

        upsertReplacingPreservingReadState: (entry) => {
          if (get().activeUserId === null) return;
          set((state) => {
            const existing = Object.hasOwn(state.byId, entry.id)
              ? state.byId[entry.id]
              : null;
            const byId = cappedAppLocalEntries({
              ...state.byId,
              [entry.id]:
                existing === null
                  ? entry
                  : { ...entry, readAt: existing.readAt },
            });
            const projection = projectAppLocalNotifications(byId);
            return {
              byId,
              orderedIds: projection.orderedIds,
              unreadCount: projection.unreadCount,
            };
          });
        },

        markAsRead: (id, readAt) => {
          if (get().activeUserId === null) return;
          set((state) => {
            if (!Object.hasOwn(state.byId, id)) return state;
            const entry = state.byId[id];
            if (entry.readAt !== null) return state;
            const byId = { ...state.byId, [id]: { ...entry, readAt } };
            const projection = projectAppLocalNotifications(byId);
            return {
              byId,
              orderedIds: projection.orderedIds,
              unreadCount: projection.unreadCount,
            };
          });
        },

        markEntityAsRead: (entity, readAt) => {
          if (get().activeUserId === null) return;
          set((state) => {
            const unreadEntries = Object.values(state.byId).filter(
              (entry) =>
                entry.readAt === null &&
                notificationPayloadBelongsToEntity(entry.payload, entity),
            );
            if (unreadEntries.length === 0) return state;
            const byId = {
              ...state.byId,
              ...Object.fromEntries(
                unreadEntries.map((entry) => [entry.id, { ...entry, readAt }]),
              ),
            };
            const projection = projectAppLocalNotifications(byId);
            return {
              byId,
              orderedIds: projection.orderedIds,
              unreadCount: projection.unreadCount,
            };
          });
        },

        markAllAsRead: (readAt) => {
          if (get().activeUserId === null) return;
          set((state) => {
            const unreadEntries = Object.values(state.byId).filter(
              (entry) => entry.readAt === null,
            );
            if (unreadEntries.length === 0) return state;
            const byId = {
              ...state.byId,
              ...Object.fromEntries(
                unreadEntries.map((entry) => [entry.id, { ...entry, readAt }]),
              ),
            };
            const projection = projectAppLocalNotifications(byId);
            return {
              byId,
              orderedIds: projection.orderedIds,
              unreadCount: projection.unreadCount,
            };
          });
        },

        clearAll: () => {
          if (get().activeUserId === null) return;
          set({ byId: {}, orderedIds: [], unreadCount: 0 });
        },

        resetForTests: () => {
          set(appLocalInitialState());
        },
      }),
      {
        ...basePersistOptions(initialName),
        version: 2,
        storage: createJSONStorage(() => window.localStorage),
        partialize: (state) => ({
          byId: state.byId,
          orderedIds: state.orderedIds,
          unreadCount: state.unreadCount,
        }),
        migrate: (persisted) =>
          migrateAppLocalNotificationsPersistedState(persisted),
      },
    ),
  );
}

export const useAppLocalNotificationsStore = createAppLocalNotificationsStore(
  appLocalNotificationsKey(null),
);

export function emitTerminalClosedNotification(input: {
  readonly instanceId: string;
  readonly hostLabel: string;
  readonly target: TerminalNotificationTarget;
}): void {
  const message = `Terminal closed: host "${input.hostLabel}" is unreachable.`;
  useAppLocalNotificationsStore.getState().upsertReplacingPreservingReadState({
    id: `terminal.closed:${input.instanceId}`,
    updatedAt: Date.now(),
    readAt: null,
    kind: "terminal.closed",
    sourceRef: input.instanceId,
    payload: input.target,
    message,
    detail: "The terminal is bound to that host and cannot migrate.",
  });
}

export function emitTerminalCrashedNotification(input: {
  readonly instanceId: string;
  readonly target: TerminalNotificationTarget;
  readonly cause: "exit" | "recovery-exhausted";
}): void {
  const isRecoveryExhausted = input.cause === "recovery-exhausted";
  useAppLocalNotificationsStore.getState().upsert({
    // Deaths must not key only on `instanceId`: app-local upsert is
    // first-write-wins, while a terminal-agent can die more than once over its
    // lifetime. UUIDs make two independent death observations distinct even if
    // they occur in the same millisecond.
    id: `terminal.crashed:${input.instanceId}:${uuidv4()}`,
    updatedAt: Date.now(),
    readAt: null,
    kind: "terminal.crashed",
    sourceRef: input.instanceId,
    payload: input.target,
    message: isRecoveryExhausted
      ? "Terminal connection could not be recovered."
      : "Terminal exited unexpectedly.",
    detail: isRecoveryExhausted
      ? "Reconnect manually to try again."
      : "The terminal process ended with an error.",
  });
}

export function emitChatStreamErrorNotification(input: {
  readonly epicId: string;
  readonly chatId: string;
  readonly details: FatalErrorDetails;
}): void {
  useAppLocalNotificationsStore.getState().upsert({
    id: `stream.transport.error:${input.chatId}:${input.details.code}`,
    updatedAt: Date.now(),
    readAt: null,
    kind: "stream.transport.error",
    sourceRef: input.chatId,
    payload: {
      kind: "chat",
      epicId: input.epicId,
      chatId: input.chatId,
    },
    message: "Chat stream closed unexpectedly.",
    detail: input.details.reason,
  });
}

export function emitHostErrorNotification(input: {
  readonly id: string;
  readonly message: string;
  readonly detail: string | null;
  readonly payload: NotificationPayload | null;
}): void {
  useAppLocalNotificationsStore.getState().upsertReplacing({
    id: `host.error:${input.id}`,
    updatedAt: Date.now(),
    readAt: null,
    kind: "host.error",
    sourceRef: input.id,
    payload: input.payload,
    message: input.message,
    detail: input.detail,
  });
}

export function selectAppLocalNotificationIds(
  state: AppLocalNotificationsState,
): ReadonlyArray<string> {
  return state.orderedIds;
}

export function selectAppLocalNotificationUnreadCount(
  state: AppLocalNotificationsState,
): number {
  return state.unreadCount;
}

export function makeSelectAppLocalNotificationById(id: string) {
  return (
    state: AppLocalNotificationsState,
  ): AppLocalNotificationEntry | null => state.byId[id] ?? null;
}

export function useAppLocalNotificationIds(): ReadonlyArray<string> {
  return useAppLocalNotificationsStore(selectAppLocalNotificationIds);
}

export function useAppLocalNotificationUnreadCount(): number {
  return useAppLocalNotificationsStore(selectAppLocalNotificationUnreadCount);
}

export function useAppLocalNotificationById(
  id: string,
): AppLocalNotificationEntry | null {
  const selector = useMemo(() => makeSelectAppLocalNotificationById(id), [id]);
  return useAppLocalNotificationsStore(selector);
}

export function __resetAppLocalNotificationsStoreForTests(): void {
  useAppLocalNotificationsStore.persist.setOptions({
    name: appLocalNotificationsKey(null),
  });
  useAppLocalNotificationsStore.getState().resetForTests();
}
