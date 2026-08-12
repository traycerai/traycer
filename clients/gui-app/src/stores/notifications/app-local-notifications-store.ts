import { useMemo } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { v4 as uuidv4 } from "uuid";
import type { FatalErrorDetails } from "@traycer/protocol/framework/ws-protocol";
import type { NotificationPayload } from "@/lib/notifications";
import {
  notificationEntitiesMatch,
  notificationEntityFromPayload,
  notificationPayloadBelongsToEntity,
  parseNotificationPayload,
} from "@/lib/notifications";
import { appLocalNotificationsKey, basePersistOptions } from "@/lib/persist";
import type { HostNotificationsEntityRef } from "@traycer/protocol/host/notifications/contracts";
import { clearAppLocalDisplayReceipts } from "@/lib/notifications/app-local-display-receipts";
import {
  APP_LOCAL_COMPLETION_RECEIPT_CAP_PER_HOST,
  APP_LOCAL_COMPLETION_RECEIPT_GLOBAL_CAP,
  hasAppLocalCompletionReceipt,
  recordAppLocalCompletionReceipts,
  removeAppLocalCompletionReceipts,
} from "@/lib/notifications/app-local-completion-receipts";

type TerminalNotificationTarget = Extract<
  NotificationPayload,
  { readonly kind: "terminal" }
>;

export const APP_LOCAL_NOTIFICATIONS_ROW_CAP = 200;

/**
 * Completion observations are causal guards, not feed rows. Keep enough per
 * host to cover the whole local notification window plus churn between
 * snapshots, while explicit host retention frames remove ids sooner.
 */
export const APP_LOCAL_OBSERVED_COMPLETION_CAP_PER_HOST =
  APP_LOCAL_COMPLETION_RECEIPT_CAP_PER_HOST;

export const APP_LOCAL_OBSERVED_COMPLETION_GLOBAL_CAP =
  APP_LOCAL_COMPLETION_RECEIPT_GLOBAL_CAP;

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

export interface AppLocalNotificationInput {
  readonly id: string;
  /**
   * Host that produced this renderer-local failure. Legacy and host-agnostic
   * rows omit it; those rows must never be consumed by a host completion
   * because their lineage cannot be proven.
   */
  readonly originHostId?: string | null;
  readonly updatedAt: number;
  readonly readAt: number | null;
  readonly kind: AppLocalNotificationKind;
  readonly sourceRef: string | null;
  readonly payload: NotificationPayload | null;
  readonly message: string;
  readonly detail: string | null;
}

export interface AppLocalNotificationEntry extends AppLocalNotificationInput {
  /**
   * `null` means this row still needs a renderer display. A matching timestamp
   * is the row-local projection of the separate monotonic display receipt.
   * Legacy persisted rows have no field and therefore read as `undefined`;
   * they predate receipts and are treated as already displayed so an upgrade
   * cannot replay an unread backlog.
   */
  readonly displayedUpdatedAt: number | null | undefined;
}

interface AppLocalNotificationsProjection {
  readonly orderedIds: ReadonlyArray<string>;
  readonly unreadCount: number;
}

interface ObservedCompletion {
  readonly id: string;
  readonly occurrenceKey: string;
  readonly observedAt: number;
}

type CompletionOccurrence = Omit<ObservedCompletion, "observedAt">;

export interface CompletionObservation {
  readonly originHostId: string;
  readonly completion: CompletionOccurrence;
  /** `null` seeds replay protection without consuming an app-local failure. */
  readonly entity: HostNotificationsEntityRef | null;
  readonly observedAt: number;
}

export interface AppLocalNotificationsState {
  readonly activeUserId: string | null;
  readonly byId: Readonly<Record<string, AppLocalNotificationEntry>>;
  readonly orderedIds: ReadonlyArray<string>;
  readonly unreadCount: number;
  readonly observedCompletionsByHost: Readonly<
    Partial<Record<string, ReadonlyArray<ObservedCompletion>>>
  >;

  activateIdentity: (userId: string) => void;
  deactivateIdentity: () => void;
  /** Discards the current identity's rows while keeping that identity active
   * for new local arrivals. Cloud-only mode must have no local shadow feed. */
  reset: () => void;
  upsert: (entry: AppLocalNotificationInput) => void;
  upsertReplacing: (entry: AppLocalNotificationInput) => void;
  upsertRecurringFailure: (entry: AppLocalNotificationInput) => void;
  upsertReplacingPreservingReadState: (
    entry: AppLocalNotificationInput,
  ) => void;
  markAsRead: (id: string, readAt: number) => void;
  markEntityAsRead: (
    originHostId: string | null,
    entity: HostNotificationsEntityRef,
    readAt: number,
  ) => void;
  markEntityAsReadBefore: (
    originHostId: string,
    entity: HostNotificationsEntityRef,
    readAt: number,
    beforeUpdatedAt: number,
  ) => void;
  observeCompletion: (
    originHostId: string,
    completion: CompletionOccurrence,
    entity: HostNotificationsEntityRef,
    observedAt: number,
  ) => void;
  seedCompletion: (
    originHostId: string,
    completion: CompletionOccurrence,
    observedAt: number,
  ) => void;
  recordCompletions: (
    observations: ReadonlyArray<CompletionObservation>,
  ) => void;
  removeObservedCompletions: (
    originHostId: string,
    completionIds: ReadonlyArray<string>,
  ) => void;
  markAllAsRead: (readAt: number) => void;
  markAsDisplayed: (id: string, updatedAt: number) => void;
  mergeForegroundDisplayed: (entry: AppLocalNotificationInput) => void;
  clearAll: () => void;
  resetForTests: () => void;
}

function appLocalInitialState(): Pick<
  AppLocalNotificationsState,
  | "activeUserId"
  | "byId"
  | "orderedIds"
  | "unreadCount"
  | "observedCompletionsByHost"
> {
  return {
    activeUserId: null,
    byId: {},
    orderedIds: [],
    unreadCount: 0,
    observedCompletionsByHost: {},
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

function pendingDisplayEntry(
  entry: AppLocalNotificationInput,
): AppLocalNotificationEntry {
  return { ...entry, displayedUpdatedAt: null };
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
    return {
      byId: {},
      orderedIds: [],
      unreadCount: 0,
    };
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

function appendObservedCompletions(
  observedByHost: AppLocalNotificationsState["observedCompletionsByHost"],
  observations: ReadonlyArray<CompletionObservation>,
): AppLocalNotificationsState["observedCompletionsByHost"] {
  const next = { ...observedByHost };
  const affectedHosts = new Set<string>();
  for (const observation of observations) {
    affectedHosts.add(observation.originHostId);
    next[observation.originHostId] = [
      ...(next[observation.originHostId] ?? []),
      {
        ...observation.completion,
        observedAt: observation.observedAt,
      },
    ];
  }
  for (const hostId of affectedHosts) {
    next[hostId] = (next[hostId] ?? []).slice(
      -APP_LOCAL_OBSERVED_COMPLETION_CAP_PER_HOST,
    );
  }
  const flattened = Object.entries(next)
    .flatMap(([hostId, completions]) =>
      (completions ?? []).map((observed) => ({ hostId, observed })),
    )
    .sort((left, right) => right.observed.observedAt - left.observed.observedAt)
    .slice(0, APP_LOCAL_OBSERVED_COMPLETION_GLOBAL_CAP);
  return Object.fromEntries(
    [...new Set(flattened.map(({ hostId }) => hostId))].map((hostId) => [
      hostId,
      flattened
        .filter((candidate) => candidate.hostId === hostId)
        .map(({ observed }) => observed)
        .sort((left, right) => {
          if (left.observedAt !== right.observedAt) {
            return left.observedAt - right.observedAt;
          }
          return left.occurrenceKey.localeCompare(right.occurrenceKey);
        }),
    ]),
  );
}

function isPersistedOriginHostId(
  value: unknown,
): value is string | null | undefined {
  return value === undefined || value === null || typeof value === "string";
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
    (value.detail !== null && typeof value.detail !== "string") ||
    !isPersistedOriginHostId(value.originHostId) ||
    !isPersistedDisplayReceipt(value.displayedUpdatedAt)
  ) {
    return null;
  }
  return {
    id,
    originHostId:
      typeof value.originHostId === "string" ? value.originHostId : null,
    updatedAt: value.updatedAt,
    readAt: value.readAt,
    kind: value.kind,
    sourceRef: value.sourceRef,
    payload: parseNotificationPayload(value.payload),
    message: value.message,
    detail: value.detail,
    displayedUpdatedAt: value.displayedUpdatedAt,
  };
}

export function parseForegroundAppLocalNotificationEntry(
  value: unknown,
): AppLocalNotificationInput | null {
  if (!isRecord(value) || typeof value.id !== "string") return null;
  const parsed = parsePersistedAppLocalEntry(value.id, value);
  if (parsed === null) return null;
  return {
    id: parsed.id,
    originHostId: parsed.originHostId,
    updatedAt: parsed.updatedAt,
    readAt: parsed.readAt,
    kind: parsed.kind,
    sourceRef: parsed.sourceRef,
    payload: parsed.payload,
    message: parsed.message,
    detail: parsed.detail,
  };
}

function isPersistedDisplayReceipt(
  value: unknown,
): value is number | null | undefined {
  return (
    value === undefined ||
    value === null ||
    (typeof value === "number" && Number.isFinite(value))
  );
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
          set((state) =>
            state.activeUserId === userId
              ? { activeUserId: userId }
              : {
                  activeUserId: userId,
                  observedCompletionsByHost: {},
                },
          );
        },

        deactivateIdentity: () => {
          set(appLocalInitialState());
        },

        reset: () => {
          const { activeUserId } = get();
          set({ ...appLocalInitialState(), activeUserId });
        },

        upsert: (entry) => {
          if (get().activeUserId === null) return;
          if (Object.hasOwn(get().byId, entry.id)) return;
          set((state) => {
            const pendingEntry = pendingDisplayEntry(entry);
            const byId = cappedAppLocalEntries({
              ...state.byId,
              [pendingEntry.id]: pendingEntry,
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
            const pendingEntry = pendingDisplayEntry(entry);
            const existing = Object.hasOwn(state.byId, entry.id)
              ? state.byId[entry.id]
              : null;
            const acknowledged =
              existing !== null &&
              existing.readAt !== null &&
              entry.updatedAt - existing.readAt <
                APP_LOCAL_RESURFACE_COOLDOWN_MS;
            let replacement = pendingEntry;
            if (existing !== null) {
              const preservesDisplay =
                existing.displayedUpdatedAt !== null &&
                (existing.readAt === null || acknowledged);
              replacement = {
                ...pendingEntry,
                displayedUpdatedAt: preservesDisplay
                  ? pendingEntry.updatedAt
                  : null,
              };
              if (acknowledged) {
                replacement = { ...replacement, readAt: existing.readAt };
              }
            }
            const byId = cappedAppLocalEntries({
              ...state.byId,
              [pendingEntry.id]: replacement,
            });
            const projection = projectAppLocalNotifications(byId);
            return {
              byId,
              orderedIds: projection.orderedIds,
              unreadCount: projection.unreadCount,
            };
          });
        },

        // Fatal stream closures are cause-keyed so repeated renders of the
        // same active failure stay one row. A genuinely recurring closure,
        // however, must become unread even when a completion or the user read
        // the prior occurrence. Preserve the display receipt only while the
        // existing occurrence is still unread; replacing a read occurrence is
        // a new notification that should be displayed again.
        upsertRecurringFailure: (entry) => {
          if (get().activeUserId === null) return;
          set((state) => {
            const pendingEntry = pendingDisplayEntry(entry);
            const existing = Object.hasOwn(state.byId, entry.id)
              ? state.byId[entry.id]
              : null;
            const replacement =
              existing !== null && existing.readAt === null
                ? {
                    ...pendingEntry,
                    displayedUpdatedAt:
                      existing.displayedUpdatedAt === null
                        ? null
                        : pendingEntry.updatedAt,
                  }
                : pendingEntry;
            const byId = cappedAppLocalEntries({
              ...state.byId,
              [pendingEntry.id]: replacement,
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
            const pendingEntry = pendingDisplayEntry(entry);
            const existing = Object.hasOwn(state.byId, entry.id)
              ? state.byId[entry.id]
              : null;
            let replacement = pendingEntry;
            if (existing !== null) {
              replacement = {
                ...pendingEntry,
                readAt: existing.readAt,
                displayedUpdatedAt: existing.displayedUpdatedAt,
              };
            }
            const byId = cappedAppLocalEntries({
              ...state.byId,
              [pendingEntry.id]: replacement,
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

        markEntityAsRead: (originHostId, entity, readAt) => {
          if (get().activeUserId === null) return;
          set((state) => {
            const unreadEntries = Object.values(state.byId).filter(
              (entry) =>
                entry.readAt === null &&
                (originHostId === null ||
                  (entry.originHostId ?? null) === originHostId) &&
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

        markEntityAsReadBefore: (
          originHostId,
          entity,
          readAt,
          beforeUpdatedAt,
        ) => {
          if (get().activeUserId === null) return;
          set((state) => {
            const unreadEntries = Object.values(state.byId).filter(
              (entry) =>
                entry.readAt === null &&
                (entry.originHostId ?? null) === originHostId &&
                entry.updatedAt < beforeUpdatedAt &&
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

        recordCompletions: (observations) => {
          const activeUserId = get().activeUserId;
          if (activeUserId === null || observations.length === 0) return;
          const knownByHost = new Map<string, Set<string>>();
          const accepted = observations.filter((observation) => {
            let known = knownByHost.get(observation.originHostId);
            if (known === undefined) {
              known = new Set(
                (
                  get().observedCompletionsByHost[observation.originHostId] ??
                  []
                ).map((completion) => completion.occurrenceKey),
              );
              knownByHost.set(observation.originHostId, known);
            }
            if (known.has(observation.completion.occurrenceKey)) return false;
            known.add(observation.completion.occurrenceKey);
            return true;
          });
          if (accepted.length === 0) return;
          const missingReceipts = accepted.flatMap((observation) =>
            hasAppLocalCompletionReceipt({
              userId: activeUserId,
              originHostId: observation.originHostId,
              occurrenceKey: observation.completion.occurrenceKey,
            })
              ? []
              : [
                  {
                    userId: activeUserId,
                    originHostId: observation.originHostId,
                    ...observation.completion,
                    observedAt: observation.observedAt,
                  },
                ],
          );
          if (missingReceipts.length > 0) {
            recordAppLocalCompletionReceipts(missingReceipts);
          }
          set((state) => {
            const observedCompletionsByHost = appendObservedCompletions(
              state.observedCompletionsByHost,
              accepted,
            );
            const consumedReadAt = new Map<string, number>();
            for (const observation of accepted) {
              if (observation.entity === null) continue;
              for (const entry of Object.values(state.byId)) {
                if (entry.readAt !== null || consumedReadAt.has(entry.id)) {
                  continue;
                }
                if (entry.originHostId !== observation.originHostId) continue;
                const entryEntity = notificationEntityFromPayload(
                  entry.payload,
                );
                if (
                  entryEntity !== null &&
                  notificationEntitiesMatch(entryEntity, observation.entity)
                ) {
                  consumedReadAt.set(entry.id, observation.observedAt);
                }
              }
            }
            if (consumedReadAt.size === 0) {
              return { observedCompletionsByHost };
            }
            const byId = { ...state.byId };
            for (const [id, readAt] of consumedReadAt) {
              byId[id] = { ...byId[id], readAt };
            }
            const projection = projectAppLocalNotifications(byId);
            return {
              byId,
              orderedIds: projection.orderedIds,
              unreadCount: projection.unreadCount,
              observedCompletionsByHost,
            };
          });
        },

        observeCompletion: (originHostId, completion, entity, observedAt) =>
          get().recordCompletions([
            { originHostId, completion, entity, observedAt },
          ]),

        seedCompletion: (originHostId, completion, observedAt) =>
          get().recordCompletions([
            { originHostId, completion, entity: null, observedAt },
          ]),

        removeObservedCompletions: (originHostId, completionIds) => {
          if (completionIds.length === 0) return;
          const activeUserId = get().activeUserId;
          if (activeUserId !== null) {
            removeAppLocalCompletionReceipts(
              activeUserId,
              originHostId,
              completionIds,
            );
          }
          set((state) => {
            const observedForHost =
              state.observedCompletionsByHost[originHostId];
            if (observedForHost === undefined) return state;
            const removed = new Set(completionIds);
            const retained = observedForHost.filter(
              (completion) => !removed.has(completion.id),
            );
            if (retained.length === observedForHost.length) return state;
            const observedCompletionsByHost = {
              ...state.observedCompletionsByHost,
            };
            if (retained.length === 0) {
              delete observedCompletionsByHost[originHostId];
            } else {
              observedCompletionsByHost[originHostId] = retained;
            }
            return { observedCompletionsByHost };
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

        markAsDisplayed: (id, updatedAt) => {
          set((state) => {
            if (!Object.hasOwn(state.byId, id)) return state;
            const entry = state.byId[id];
            if (entry.updatedAt !== updatedAt) return state;
            if (entry.displayedUpdatedAt === updatedAt) return state;
            return {
              byId: {
                ...state.byId,
                [id]: { ...entry, displayedUpdatedAt: updatedAt },
              },
            };
          });
        },

        mergeForegroundDisplayed: (entry) => {
          if (get().activeUserId === null) return;
          set((state) => {
            const existing = Object.hasOwn(state.byId, entry.id)
              ? state.byId[entry.id]
              : null;
            if (existing !== null && existing.updatedAt > entry.updatedAt) {
              return state;
            }
            const displayedEntry: AppLocalNotificationEntry = {
              ...entry,
              readAt: existing === null ? entry.readAt : existing.readAt,
              displayedUpdatedAt: entry.updatedAt,
            };
            const byId = cappedAppLocalEntries({
              ...state.byId,
              [entry.id]: displayedEntry,
            });
            const projection = projectAppLocalNotifications(byId);
            return {
              byId,
              orderedIds: projection.orderedIds,
              unreadCount: projection.unreadCount,
            };
          });
        },

        clearAll: () => {
          const activeUserId = get().activeUserId;
          if (activeUserId === null) return;
          clearAppLocalDisplayReceipts(activeUserId);
          set({ byId: {}, orderedIds: [], unreadCount: 0 });
        },

        resetForTests: () => {
          set(appLocalInitialState());
        },
      }),
      {
        ...basePersistOptions(initialName),
        version: 4,
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
  readonly hostId: string;
  readonly hostLabel: string;
  readonly target: TerminalNotificationTarget;
}): void {
  const message = `Terminal closed: host "${input.hostLabel}" is unreachable.`;
  useAppLocalNotificationsStore.getState().upsertReplacingPreservingReadState({
    id: `terminal.closed:${input.instanceId}`,
    originHostId: input.hostId,
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
  readonly hostId: string;
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
    originHostId: input.hostId,
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
  readonly hostId: string;
  readonly epicId: string;
  readonly chatId: string;
  readonly details: FatalErrorDetails;
}): void {
  useAppLocalNotificationsStore
    .getState()
    .upsertRecurringFailure(chatStreamErrorNotification(input));
}

export function chatStreamErrorNotification(input: {
  readonly hostId: string;
  readonly epicId: string;
  readonly chatId: string;
  readonly details: FatalErrorDetails;
}): AppLocalNotificationInput {
  return {
    id: `stream.transport.error:${input.hostId}:${input.chatId}:${input.details.code}`,
    originHostId: input.hostId,
    updatedAt: Date.now(),
    readAt: null,
    kind: "stream.transport.error",
    sourceRef: input.chatId,
    payload: {
      kind: "chat",
      epicId: input.epicId,
      chatId: input.chatId,
    },
    message: "Agent stream closed unexpectedly.",
    detail: input.details.reason,
  };
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
