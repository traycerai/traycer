import {
  appLocalNotificationDisplayReceiptFloorKey,
  appLocalNotificationDisplayReceiptFloorPrefix,
  appLocalNotificationDisplayReceiptKey,
  appLocalNotificationDisplayReceiptNotificationPrefix,
  appLocalNotificationDisplayReceiptPrefix,
} from "@/lib/persist";

export const APP_LOCAL_DISPLAY_RECEIPTS_PER_USER_CAP = 512;

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
  const compactedThrough = highestStoredVersion(
    appLocalNotificationDisplayReceiptFloorPrefix(version.userId),
  );
  if (compactedThrough !== null && version.updatedAt <= compactedThrough) {
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
  compactAppLocalDisplayReceipts(version.userId);
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
  const prefixes = [
    appLocalNotificationDisplayReceiptPrefix(userId),
    appLocalNotificationDisplayReceiptFloorPrefix(userId),
  ].map((prefix) => `${prefix}:`);
  storageKeys()
    .filter((key) => prefixes.some((prefix) => key.startsWith(prefix)))
    .forEach((key) => window.localStorage.removeItem(key));
}

function compactAppLocalDisplayReceipts(userId: string): void {
  const receipts = [
    ...storedVersions(appLocalNotificationDisplayReceiptPrefix(userId)),
  ].sort((left, right) => left.updatedAt - right.updatedAt);
  const removeCount = receipts.length - APP_LOCAL_DISPLAY_RECEIPTS_PER_USER_CAP;
  if (removeCount <= 0) return;
  const obsolete = receipts.slice(0, removeCount);
  const floor = obsolete[obsolete.length - 1].updatedAt;
  // Publish a set-only floor before deleting exact keys. Concurrent stale
  // windows can add lower floors, but readers take the maximum and no window
  // can overwrite or regress a newer compaction boundary.
  window.localStorage.setItem(
    appLocalNotificationDisplayReceiptFloorKey({ userId, updatedAt: floor }),
    "1",
  );
  compactDisplayReceiptFloors(userId);
  obsolete.forEach(({ key }) => window.localStorage.removeItem(key));
}

function compactDisplayReceiptFloors(userId: string): void {
  const prefix = appLocalNotificationDisplayReceiptFloorPrefix(userId);
  const floors = storedVersions(prefix);
  const highest = highestStoredVersion(prefix);
  if (highest === null) return;
  floors
    .filter((floor) => floor.updatedAt < highest)
    .forEach(({ key }) => window.localStorage.removeItem(key));
}

function highestStoredVersion(prefix: string): number | null {
  const versions = storedVersions(prefix);
  if (versions.length === 0) return null;
  return versions.reduce(
    (highest, version) => Math.max(highest, version.updatedAt),
    Number.NEGATIVE_INFINITY,
  );
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
