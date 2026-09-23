import { appLogger, describeLogError } from "@/lib/logger";
import { deliveryRestoreAckKey } from "@/lib/persist";

/**
 * A withdrawn opening prompt this device already put back in a chat's composer,
 * whose acknowledgement (`messageDeliveryRestored`) the host has not yet
 * answered.
 *
 * It lives on the same device-local tier as the composer draft the prompt went
 * into, and for the same length of time the in-memory
 * `unacknowledgedDeliveryRestore` does, because a reload between the restore and
 * the acknowledgement loses only the second. The draft survives, the host's
 * record still reads unclaimed, and a new session store would take the prompt
 * again and merge a second copy in front of the first. With this record a
 * reloaded store knows the composer already holds the prompt, so it resends the
 * acknowledgement instead of taking it.
 */
export interface PersistedDeliveryRestoreAck {
  readonly messageId: string;
  readonly expectedRevision: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parsePersistedDeliveryRestoreAck(
  value: unknown,
): PersistedDeliveryRestoreAck | null {
  if (!isRecord(value)) return null;
  const { messageId, expectedRevision } = value;
  if (typeof messageId !== "string" || messageId.length === 0) return null;
  if (
    typeof expectedRevision !== "number" ||
    !Number.isInteger(expectedRevision) ||
    expectedRevision < 1
  ) {
    return null;
  }
  return { messageId, expectedRevision };
}

/**
 * The acknowledgement still owed for `chatId`'s opening, or `null` when none
 * is, or when storage cannot be read. Unreadable storage costs only what it
 * did before this record existed: a take after a reload.
 */
export function readPersistedDeliveryRestoreAck(
  chatId: string,
): PersistedDeliveryRestoreAck | null {
  if (typeof window === "undefined") return null;
  // Boundary: storage can be disabled, and the stored bytes are untrusted.
  try {
    const raw = window.localStorage.getItem(deliveryRestoreAckKey(chatId));
    if (raw === null) return null;
    return parsePersistedDeliveryRestoreAck(JSON.parse(raw));
  } catch (error) {
    appLogger.warn("[delivery-restore-ack] persisted read failed", {
      error: describeLogError(error),
    });
    return null;
  }
}

/** Records the acknowledgement `chatId`'s opening owes, or clears it (`null`). */
export function writePersistedDeliveryRestoreAck(
  chatId: string,
  ack: PersistedDeliveryRestoreAck | null,
): void {
  if (typeof window === "undefined") return;
  // Boundary: localStorage can throw when full or disabled in a hardened shell.
  try {
    const key = deliveryRestoreAckKey(chatId);
    if (ack === null) {
      window.localStorage.removeItem(key);
      return;
    }
    window.localStorage.setItem(
      key,
      JSON.stringify({
        messageId: ack.messageId,
        expectedRevision: ack.expectedRevision,
      }),
    );
  } catch (error) {
    appLogger.warn("[delivery-restore-ack] persisted write failed", {
      error: describeLogError(error),
    });
  }
}
