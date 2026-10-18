import { z } from "zod";
import { appLogger, describeLogError } from "@/lib/logger";

const DELETED_EPIC_NOTIFICATION_CHANNEL =
  "traycer-gui-app:deleted-epic-events:v1";

export const DELETED_EPIC_NOTIFICATION_STORAGE_KEY =
  "traycer-gui-app:deleted-epic-events:last";

const SEEN_NOTIFICATION_TTL_MS = 5 * 60 * 1000;

// Fields every version carries.
const deletedEpicNotificationFields = {
  id: z.string().min(1).optional(),
  type: z.literal("epic-deleted"),
  originId: z.string().min(1),
  sequence: z.number(),
  createdAt: z.number(),
  hostId: z.string().min(1),
  userId: z.string().min(1),
  epicIds: z.array(z.string().min(1)),
  epicTitlesById: z.record(z.string(), z.string()).default({}),
};

/**
 * Two versions on one channel, because a deletion's scope changes what a
 * receiver may tear down and a window that predates scopes reads only `1`:
 *
 * - `1`: every `epicIds` entry was deleted from the account. What every
 *   window has always read.
 * - `2`: every `epicIds` entry was deleted on `hostId` alone (a local-homed
 *   Task), whose id another host may still serve. A window that predates it
 *   rejects the version and ignores the message, rather than reading the
 *   ids as account-wide and closing a same-id Task that still exists.
 *
 * A deletion with both scopes is published as one message of each.
 */
const deletedEpicNotificationSchema = z
  .discriminatedUnion("version", [
    z.object({ ...deletedEpicNotificationFields, version: z.literal(1) }),
    z.object({ ...deletedEpicNotificationFields, version: z.literal(2) }),
  ])
  .transform((notification) => ({
    ...notification,
    id:
      notification.id ??
      fallbackDeletedEpicNotificationId(
        notification.originId,
        notification.sequence,
      ),
    /** The `epicIds` deleted on `hostId` only: all of them on `2`. */
    hostScopedEpicIds: notification.version === 2 ? notification.epicIds : [],
  }));

export type DeletedEpicNotification = z.infer<
  typeof deletedEpicNotificationSchema
>;

/** A notification as it travels: the scope is the version, not a field. */
type DeletedEpicNotificationWire = z.input<
  typeof deletedEpicNotificationSchema
>;

export interface PublishDeletedEpicNotificationInput {
  /** The host that enacted the delete. */
  readonly hostId: string;
  readonly userId: string;
  readonly epicIds: ReadonlyArray<string>;
  /** The subset of `epicIds` deleted on `hostId` only, not the account. */
  readonly hostScopedEpicIds: ReadonlyArray<string>;
  readonly epicTitlesById: Readonly<Record<string, string>>;
}

type DeletedEpicNotificationListener = (
  notification: DeletedEpicNotification,
) => void;

const originId = createOriginId();
const listeners = new Set<DeletedEpicNotificationListener>();
const seenNotificationExpiresAtById = new Map<string, number>();
let broadcastChannel: BroadcastChannel | null = null;
let sequence = 0;
let storageListenerInstalled = false;

export function publishDeletedEpicNotification(
  input: PublishDeletedEpicNotificationInput,
): void {
  const epicIds = uniqueStrings(input.epicIds);
  if (epicIds.length === 0) return;
  const hostScoped = new Set(subsetOf(epicIds, input.hostScopedEpicIds));
  publishVersion(
    input,
    1,
    epicIds.filter((id) => !hostScoped.has(id)),
  );
  publishVersion(input, 2, [...hostScoped]);
}

function publishVersion(
  input: PublishDeletedEpicNotificationInput,
  version: 1 | 2,
  epicIds: ReadonlyArray<string>,
): void {
  if (epicIds.length === 0) return;
  sequence += 1;
  const wire: DeletedEpicNotificationWire = {
    id: createDeletedEpicNotificationId(sequence),
    type: "epic-deleted",
    version,
    originId,
    sequence,
    createdAt: Date.now(),
    hostId: input.hostId,
    userId: input.userId,
    epicIds: [...epicIds],
    epicTitlesById: titlesForEpicIds(epicIds, input.epicTitlesById),
  };
  appLogger.debug("[deleted-epic-events] publishing notification", {
    hostId: input.hostId,
    epicCount: epicIds.length,
    version,
    sequence,
  });
  postBroadcastNotification(wire);
  writeStorageNotification(wire);
}

export function subscribeDeletedEpicNotifications(
  listener: DeletedEpicNotificationListener,
): () => void {
  listeners.add(listener);
  ensureDeletedEpicNotificationTransport();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      teardownDeletedEpicNotificationTransport();
    }
  };
}

function ensureDeletedEpicNotificationTransport(): void {
  if (typeof BroadcastChannel !== "undefined" && broadcastChannel === null) {
    broadcastChannel = new BroadcastChannel(DELETED_EPIC_NOTIFICATION_CHANNEL);
    broadcastChannel.addEventListener("message", handleBroadcastMessage);
  }
  if (typeof window !== "undefined" && !storageListenerInstalled) {
    window.addEventListener("storage", handleStorageEvent);
    storageListenerInstalled = true;
  }
}

function teardownDeletedEpicNotificationTransport(): void {
  if (broadcastChannel !== null) {
    broadcastChannel.removeEventListener("message", handleBroadcastMessage);
    broadcastChannel.close();
    broadcastChannel = null;
  }
  if (typeof window !== "undefined") {
    window.removeEventListener("storage", handleStorageEvent);
    storageListenerInstalled = false;
  }
}

function handleBroadcastMessage(event: MessageEvent<unknown>): void {
  const notification = parseDeletedEpicNotification(event.data);
  if (notification === null) {
    appLogger.warn(
      "[deleted-epic-events] ignored malformed broadcast message",
      {},
    );
    return;
  }
  emitIncomingNotification(notification);
}

function handleStorageEvent(event: StorageEvent): void {
  if (event.key !== DELETED_EPIC_NOTIFICATION_STORAGE_KEY) return;
  if (event.newValue === null) return;
  const notification = parseDeletedEpicNotificationJson(event.newValue);
  if (notification === null) {
    appLogger.warn(
      "[deleted-epic-events] ignored malformed storage message",
      {},
    );
    return;
  }
  emitIncomingNotification(notification);
}

function emitIncomingNotification(notification: DeletedEpicNotification): void {
  if (notification.originId === originId) return;
  if (markDuplicateNotificationSeen(notification.id)) return;
  const epicIds = uniqueStrings(notification.epicIds);
  if (epicIds.length === 0) return;
  const normalized = {
    ...notification,
    epicIds,
    hostScopedEpicIds: subsetOf(epicIds, notification.hostScopedEpicIds),
    epicTitlesById: titlesForEpicIds(epicIds, notification.epicTitlesById),
  };
  for (const listener of listeners) {
    listener(normalized);
  }
}

function markDuplicateNotificationSeen(notificationId: string): boolean {
  const now = Date.now();
  pruneSeenNotifications(now);
  if (seenNotificationExpiresAtById.has(notificationId)) return true;
  seenNotificationExpiresAtById.set(
    notificationId,
    now + SEEN_NOTIFICATION_TTL_MS,
  );
  return false;
}

function pruneSeenNotifications(now: number): void {
  for (const [notificationId, expiresAt] of seenNotificationExpiresAtById) {
    if (expiresAt > now) continue;
    seenNotificationExpiresAtById.delete(notificationId);
  }
}

function postBroadcastNotification(
  notification: DeletedEpicNotificationWire,
): void {
  if (typeof BroadcastChannel === "undefined") return;
  const channel =
    broadcastChannel ?? new BroadcastChannel(DELETED_EPIC_NOTIFICATION_CHANNEL);
  channel.postMessage(notification);
  if (channel !== broadcastChannel) {
    channel.close();
  }
}

function writeStorageNotification(
  notification: DeletedEpicNotificationWire,
): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      DELETED_EPIC_NOTIFICATION_STORAGE_KEY,
      JSON.stringify(notification),
    );
  } catch (error) {
    appLogger.warn("[deleted-epic-events] storage notification write failed", {
      epicCount: notification.epicIds.length,
      error: describeLogError(error),
    });
    // localStorage can be unavailable in hardened browser contexts. The
    // BroadcastChannel path above is enough when supported.
  }
}

function parseDeletedEpicNotification(
  value: unknown,
): DeletedEpicNotification | null {
  const parsed = deletedEpicNotificationSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseDeletedEpicNotificationJson(
  value: string,
): DeletedEpicNotification | null {
  try {
    return parseDeletedEpicNotification(JSON.parse(value));
  } catch (error) {
    appLogger.warn(
      "[deleted-epic-events] storage notification JSON parse failed",
      {
        error: describeLogError(error),
      },
    );
    return null;
  }
}

function uniqueStrings(values: ReadonlyArray<string>): string[] {
  return Array.from(new Set(values.filter((value) => value.length > 0)));
}

function subsetOf(
  epicIds: ReadonlyArray<string>,
  candidates: ReadonlyArray<string>,
): string[] {
  const allowedIds = new Set(epicIds);
  return uniqueStrings(candidates).filter((id) => allowedIds.has(id));
}

function createDeletedEpicNotificationId(notificationSequence: number): string {
  return fallbackDeletedEpicNotificationId(originId, notificationSequence);
}

function fallbackDeletedEpicNotificationId(
  notificationOriginId: string,
  notificationSequence: number,
): string {
  return `${notificationOriginId}:${notificationSequence}`;
}

function titlesForEpicIds(
  epicIds: ReadonlyArray<string>,
  titlesById: Readonly<Record<string, string>>,
): Record<string, string> {
  const allowedIds = new Set(epicIds);
  const titles: Record<string, string> = {};
  for (const [epicId, title] of Object.entries(titlesById)) {
    if (!allowedIds.has(epicId)) continue;
    const normalizedTitle = normalizeEpicTitle(title);
    if (normalizedTitle === null) continue;
    titles[epicId] = normalizedTitle;
  }
  return titles;
}

function normalizeEpicTitle(title: string): string | null {
  const trimmed = title.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function createOriginId(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
