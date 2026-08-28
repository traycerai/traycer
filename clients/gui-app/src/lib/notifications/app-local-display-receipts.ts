import {
  appLocalNotificationDisplayReceiptKey,
  appLocalNotificationDisplayReceiptNotificationPrefix,
  appLocalNotificationDisplayReceiptPrefix,
} from "@/lib/persist";

export const APP_LOCAL_DISPLAY_RECEIPT_NOTIFICATION_CAP = 512;
export const APP_LOCAL_DISPLAY_RECEIPT_VERSION_CAP = 8;

const receiptSessionGenerationByUserId = new Map<string, number>();

export interface AppLocalDisplayReceiptVersion {
  readonly userId: string;
  readonly notificationId: string;
  readonly updatedAt: number;
}

export interface AppLocalDisplayReceiptSession {
  readonly userId: string;
  readonly generation: number;
}

interface StoredVersion {
  readonly key: string;
  readonly updatedAt: number;
}

interface StoredReceipt extends StoredVersion {
  readonly notificationKey: string;
}

export function appLocalDisplayDeliveryKey(
  version: AppLocalDisplayReceiptVersion,
): string {
  return appLocalNotificationDisplayReceiptKey(version);
}

export function hasAppLocalDisplayReceipt(
  version: AppLocalDisplayReceiptVersion,
): boolean {
  if (
    window.localStorage.getItem(
      appLocalNotificationDisplayReceiptKey(version),
    ) === "1"
  ) {
    return true;
  }
  return storedVersions(
    appLocalNotificationDisplayReceiptNotificationPrefix(version),
  ).some((stored) => stored.updatedAt >= version.updatedAt);
}

export function recordAppLocalDisplayReceipt(
  version: AppLocalDisplayReceiptVersion,
): void {
  window.localStorage.setItem(
    appLocalNotificationDisplayReceiptKey(version),
    "1",
  );
  compactNotificationVersions(version);
  compactNotificationIds(version);
}

export function captureAppLocalDisplayReceiptSession(
  userId: string,
): AppLocalDisplayReceiptSession {
  return {
    userId,
    generation: receiptSessionGeneration(userId),
  };
}

export function isAppLocalDisplayReceiptSessionCurrent(
  session: AppLocalDisplayReceiptSession,
): boolean {
  return receiptSessionGeneration(session.userId) === session.generation;
}

export function clearAppLocalDisplayReceipts(userId: string): void {
  receiptSessionGenerationByUserId.set(
    userId,
    receiptSessionGeneration(userId) + 1,
  );
  const prefix = `${appLocalNotificationDisplayReceiptPrefix(userId)}:`;
  storageKeys()
    .filter((key) => key.startsWith(prefix))
    .forEach((key) => window.localStorage.removeItem(key));
}

function compactNotificationVersions(
  version: AppLocalDisplayReceiptVersion,
): void {
  const obsolete = [
    ...storedVersions(
      appLocalNotificationDisplayReceiptNotificationPrefix(version),
    ),
  ]
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(APP_LOCAL_DISPLAY_RECEIPT_VERSION_CAP);
  obsolete.forEach(({ key }) => window.localStorage.removeItem(key));
}

function compactNotificationIds(version: AppLocalDisplayReceiptVersion): void {
  const receipts = storedReceiptsForUser(version.userId);
  const latestByNotificationKey = new Map<string, number>();
  receipts.forEach((receipt) => {
    latestByNotificationKey.set(
      receipt.notificationKey,
      Math.max(
        latestByNotificationKey.get(receipt.notificationKey) ??
          Number.NEGATIVE_INFINITY,
        receipt.updatedAt,
      ),
    );
  });
  if (
    latestByNotificationKey.size <= APP_LOCAL_DISPLAY_RECEIPT_NOTIFICATION_CAP
  ) {
    return;
  }
  // Forget the oldest IDs once the index is full. That can permit a retry for
  // an ancient evicted row, but unlike a user-wide watermark it can never
  // suppress a notification ID that has no display evidence of its own.
  const currentNotificationKey = encodedNotificationKey(version);
  const obsoleteNotificationKeys = new Set(
    [...latestByNotificationKey.entries()]
      .sort((left, right) => {
        const leftIsCurrent = left[0] === currentNotificationKey;
        const rightIsCurrent = right[0] === currentNotificationKey;
        if (leftIsCurrent !== rightIsCurrent) return leftIsCurrent ? -1 : 1;
        return right[1] - left[1];
      })
      .slice(APP_LOCAL_DISPLAY_RECEIPT_NOTIFICATION_CAP)
      .map(([notificationKey]) => notificationKey),
  );
  receipts
    .filter((receipt) => obsoleteNotificationKeys.has(receipt.notificationKey))
    .forEach(({ key }) => window.localStorage.removeItem(key));
}

function storedReceiptsForUser(userId: string): ReadonlyArray<StoredReceipt> {
  const prefix = `${appLocalNotificationDisplayReceiptPrefix(userId)}:`;
  return storageKeys().flatMap((key) => {
    if (!key.startsWith(prefix)) return [];
    if (window.localStorage.getItem(key) !== "1") return [];
    const suffix = key.slice(prefix.length);
    const separatorIndex = suffix.lastIndexOf(":");
    if (separatorIndex <= 0) return [];
    const updatedAt = Number(suffix.slice(separatorIndex + 1));
    if (!Number.isFinite(updatedAt)) return [];
    return [
      {
        key,
        notificationKey: suffix.slice(0, separatorIndex),
        updatedAt,
      },
    ];
  });
}

function storedVersions(prefix: string): ReadonlyArray<StoredVersion> {
  const qualifiedPrefix = `${prefix}:`;
  return storageKeys().flatMap((key) => {
    if (!key.startsWith(qualifiedPrefix)) return [];
    if (window.localStorage.getItem(key) !== "1") return [];
    const updatedAt = Number(key.slice(key.lastIndexOf(":") + 1));
    if (!Number.isFinite(updatedAt)) return [];
    return [{ key, updatedAt }];
  });
}

function encodedNotificationKey(
  version: AppLocalDisplayReceiptVersion,
): string {
  const userPrefix = `${appLocalNotificationDisplayReceiptPrefix(version.userId)}:`;
  return appLocalNotificationDisplayReceiptNotificationPrefix(version).slice(
    userPrefix.length,
  );
}

function storageKeys(): ReadonlyArray<string> {
  const keys: string[] = [];
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (key !== null) keys.push(key);
  }
  return keys;
}

function receiptSessionGeneration(userId: string): number {
  return receiptSessionGenerationByUserId.get(userId) ?? 0;
}
