import { z } from "zod";
import { appLogger, describeLogError } from "@/lib/logger";

const DELETED_EPIC_NOTIFICATION_CHANNEL =
  "traycer-gui-app:deleted-epic-events:v1";

export const DELETED_EPIC_NOTIFICATION_STORAGE_KEY =
  "traycer-gui-app:deleted-epic-events:last";

const SEEN_NOTIFICATION_TTL_MS = 5 * 60 * 1000;

const deletedEpicNotificationSchema = z
  .object({
    id: z.string().min(1).optional(),
    type: z.literal("epic-deleted"),
    version: z.literal(1),
    originId: z.string().min(1),
    sequence: z.number(),
    createdAt: z.number(),
    hostId: z.string().min(1),
    userId: z.string().min(1),
    epicIds: z.array(z.string().min(1)),
    epicTitlesById: z.record(z.string(), z.string()).default({}),
  })
  .transform((notification) => ({
    ...notification,
    id:
      notification.id ??
      fallbackDeletedEpicNotificationId(
        notification.originId,
        notification.sequence,
      ),
  }));

export type DeletedEpicNotification = z.infer<
  typeof deletedEpicNotificationSchema
>;

export interface PublishDeletedEpicNotificationInput {
  readonly hostId: string;
  readonly userId: string;
  readonly epicIds: ReadonlyArray<string>;
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
  sequence += 1;
  const notification: DeletedEpicNotification = {
    id: createDeletedEpicNotificationId(sequence),
    type: "epic-deleted",
    version: 1,
    originId,
    sequence,
    createdAt: Date.now(),
    hostId: input.hostId,
    userId: input.userId,
    epicIds,
    epicTitlesById: titlesForEpicIds(epicIds, input.epicTitlesById),
  };
  appLogger.debug("[deleted-epic-events] publishing notification", {
    hostId: input.hostId,
    epicCount: epicIds.length,
    sequence,
  });
  postBroadcastNotification(notification);
  writeStorageNotification(notification);
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
  notification: DeletedEpicNotification,
): void {
  if (typeof BroadcastChannel === "undefined") return;
  const channel =
    broadcastChannel ?? new BroadcastChannel(DELETED_EPIC_NOTIFICATION_CHANNEL);
  channel.postMessage(notification);
  if (channel !== broadcastChannel) {
    channel.close();
  }
}

function writeStorageNotification(notification: DeletedEpicNotification): void {
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
