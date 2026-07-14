import type {
  HostNotificationEntry,
  HostNotificationsEntityRef,
} from "@traycer/protocol/host/notifications/contracts";

/**
 * The entity a HOST notification addresses, from the wire entry's typed
 * entity fields (sourced host-side from the row's durable columns). This is
 * the one contract for host rows: a payload the semantic parse rejects still
 * addresses its entity, and a payload cannot claim an entity its row does
 * not have. The payload-based reader below serves app-local notifications
 * only, whose payloads are renderer-typed.
 */
export function notificationEntityFromHostEntry(
  entry: HostNotificationEntry,
): HostNotificationsEntityRef | null {
  if (entry.epicId === null) return null;
  return entry.chatId === null
    ? { epicId: entry.epicId }
    : { epicId: entry.epicId, chatId: entry.chatId };
}

/** Returns the table entity addressed by an app-local notification payload. */
export function notificationEntityFromPayload(
  payload: unknown,
): HostNotificationsEntityRef | null {
  if (!isRecord(payload)) return null;
  const record = payload;
  const epicId = readNonEmptyString(record.epicId);
  if (epicId === null) return null;
  const chatId = readNonEmptyString(record.chatId);
  return chatId === null ? { epicId } : { epicId, chatId };
}

export function notificationEntitiesMatch(
  left: HostNotificationsEntityRef,
  right: HostNotificationsEntityRef,
): boolean {
  return left.epicId === right.epicId && left.chatId === right.chatId;
}

export function notificationPayloadBelongsToEntity(
  payload: unknown,
  entity: HostNotificationsEntityRef,
): boolean {
  const payloadEntity = notificationEntityFromPayload(payload);
  if (payloadEntity === null || payloadEntity.epicId !== entity.epicId) {
    return false;
  }
  return entity.chatId === undefined
    ? payloadEntity.chatId === undefined
    : payloadEntity.chatId === entity.chatId;
}

/** Returns whether a payload belongs anywhere under an epic's rollup scope. */
export function notificationPayloadBelongsToEpic(
  payload: unknown,
  epicId: string,
): boolean {
  return notificationEntityFromPayload(payload)?.epicId === epicId;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
