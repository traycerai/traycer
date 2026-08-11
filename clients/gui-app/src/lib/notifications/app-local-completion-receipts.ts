import {
  appLocalNotificationCompletionReceiptHostPrefix,
  appLocalNotificationCompletionReceiptKey,
  appLocalNotificationCompletionReceiptPrefix,
} from "@/lib/persist";

export const APP_LOCAL_COMPLETION_RECEIPT_CAP_PER_HOST = 400;
export const APP_LOCAL_COMPLETION_RECEIPT_GLOBAL_CAP = 800;

export interface AppLocalCompletionReceipt {
  readonly userId: string;
  readonly originHostId: string;
  readonly id: string;
  readonly occurrenceKey: string;
  readonly observedAt: number;
}

interface StoredCompletionReceipt extends AppLocalCompletionReceipt {
  readonly key: string;
}

export function hasAppLocalCompletionReceipt(
  receipt: Omit<AppLocalCompletionReceipt, "id" | "observedAt">,
): boolean {
  return (
    window.localStorage.getItem(
      appLocalNotificationCompletionReceiptKey(receipt),
    ) !== null
  );
}

export function recordAppLocalCompletionReceipt(
  receipt: AppLocalCompletionReceipt,
): void {
  window.localStorage.setItem(
    appLocalNotificationCompletionReceiptKey(receipt),
    JSON.stringify({
      id: receipt.id,
      observedAt: receipt.observedAt,
    }),
  );
  compactCompletionReceipts(receipt.userId, receipt.originHostId);
}

export function removeAppLocalCompletionReceipts(
  userId: string,
  originHostId: string,
  completionIds: ReadonlyArray<string>,
): void {
  if (completionIds.length === 0) return;
  const removed = new Set(completionIds);
  storedCompletionReceiptsForHost(userId, originHostId)
    .filter((receipt) => removed.has(receipt.id))
    .forEach((receipt) => window.localStorage.removeItem(receipt.key));
}

function compactCompletionReceipts(userId: string, originHostId: string): void {
  const hostReceipts = storedCompletionReceiptsForHost(userId, originHostId);
  removeOldestReceipts(hostReceipts, APP_LOCAL_COMPLETION_RECEIPT_CAP_PER_HOST);
  removeOldestReceipts(
    storedCompletionReceiptsForUser(userId),
    APP_LOCAL_COMPLETION_RECEIPT_GLOBAL_CAP,
  );
}

function removeOldestReceipts(
  receipts: ReadonlyArray<StoredCompletionReceipt>,
  cap: number,
): void {
  if (receipts.length <= cap) return;
  [...receipts]
    .sort((left, right) => {
      if (left.observedAt !== right.observedAt) {
        return right.observedAt - left.observedAt;
      }
      return right.key.localeCompare(left.key);
    })
    .slice(cap)
    .forEach((receipt) => window.localStorage.removeItem(receipt.key));
}

function storedCompletionReceiptsForHost(
  userId: string,
  originHostId: string,
): ReadonlyArray<StoredCompletionReceipt> {
  const prefix = `${appLocalNotificationCompletionReceiptHostPrefix({ userId, originHostId })}:`;
  return storedCompletionReceiptsForPrefix(userId, originHostId, prefix);
}

function storedCompletionReceiptsForUser(
  userId: string,
): ReadonlyArray<StoredCompletionReceipt> {
  const prefix = `${appLocalNotificationCompletionReceiptPrefix(userId)}:`;
  return storedCompletionReceiptsForPrefix(userId, null, prefix);
}

function storedCompletionReceiptsForPrefix(
  userId: string,
  requestedOriginHostId: string | null,
  prefix: string,
): ReadonlyArray<StoredCompletionReceipt> {
  return storageKeys().flatMap((key) => {
    if (!key.startsWith(prefix)) return [];
    const value = window.localStorage.getItem(key);
    if (value === null) return [];
    try {
      const parsed: unknown = JSON.parse(value);
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        !("id" in parsed) ||
        typeof parsed.id !== "string" ||
        !("observedAt" in parsed) ||
        typeof parsed.observedAt !== "number" ||
        !Number.isFinite(parsed.observedAt)
      ) {
        return [];
      }
      const suffix = key.slice(prefix.length);
      const separatorIndex = suffix.indexOf(":");
      if (requestedOriginHostId === null && separatorIndex <= 0) return [];
      const originHostId = decodeURIComponent(
        requestedOriginHostId === null
          ? suffix.slice(0, separatorIndex)
          : requestedOriginHostId,
      );
      const occurrenceKey = decodeURIComponent(
        requestedOriginHostId === null
          ? suffix.slice(separatorIndex + 1)
          : suffix,
      );
      return [
        {
          key,
          userId,
          originHostId,
          id: parsed.id,
          occurrenceKey,
          observedAt: parsed.observedAt,
        },
      ];
    } catch {
      return [];
    }
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
