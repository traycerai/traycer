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
  const key = appLocalNotificationCompletionReceiptKey(receipt);
  const value = window.localStorage.getItem(key);
  if (value === null) return false;
  if (parseStoredCompletionReceiptValue(value) !== null) return true;
  window.localStorage.removeItem(key);
  return false;
}

export function recordAppLocalCompletionReceipt(
  receipt: AppLocalCompletionReceipt,
): void {
  recordAppLocalCompletionReceipts([receipt]);
}

export function recordAppLocalCompletionReceipts(
  receipts: ReadonlyArray<AppLocalCompletionReceipt>,
): void {
  for (const receipt of receipts) {
    try {
      window.localStorage.setItem(
        appLocalNotificationCompletionReceiptKey(receipt),
        JSON.stringify({
          id: receipt.id,
          observedAt: receipt.observedAt,
        }),
      );
    } catch {
      // Receipt persistence is best-effort. The in-memory ledger must still
      // advance so a full or unavailable localStorage cannot abort the whole
      // completion batch and leave matching failures unreconciled.
    }
  }
  const hostsByUser = new Map<string, Set<string>>();
  for (const receipt of receipts) {
    const hostIds = hostsByUser.get(receipt.userId) ?? new Set<string>();
    hostIds.add(receipt.originHostId);
    hostsByUser.set(receipt.userId, hostIds);
  }
  for (const [userId, hostIds] of hostsByUser) {
    const stored = storedCompletionReceiptsForUser(userId);
    const removedForHostCaps = new Set<string>();
    for (const originHostId of hostIds) {
      const removed = removeOldestReceipts(
        stored.filter((receipt) => receipt.originHostId === originHostId),
        APP_LOCAL_COMPLETION_RECEIPT_CAP_PER_HOST,
      );
      for (const key of removed) removedForHostCaps.add(key);
    }
    removeOldestReceipts(
      stored.filter((receipt) => !removedForHostCaps.has(receipt.key)),
      APP_LOCAL_COMPLETION_RECEIPT_GLOBAL_CAP,
    );
  }
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

export function clearAppLocalCompletionReceipts(userId: string): void {
  const prefix = `${appLocalNotificationCompletionReceiptPrefix(userId)}:`;
  storageKeys()
    .filter((key) => key.startsWith(prefix))
    .forEach((key) => window.localStorage.removeItem(key));
}

function removeOldestReceipts(
  receipts: ReadonlyArray<StoredCompletionReceipt>,
  cap: number,
): ReadonlySet<string> {
  if (receipts.length <= cap) return new Set();
  const removed = [...receipts]
    .sort((left, right) => {
      if (left.observedAt !== right.observedAt) {
        return right.observedAt - left.observedAt;
      }
      return right.key.localeCompare(left.key);
    })
    .slice(cap);
  removed.forEach((receipt) => window.localStorage.removeItem(receipt.key));
  return new Set(removed.map((receipt) => receipt.key));
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
    const parsed = parseStoredCompletionReceiptValue(value);
    if (parsed === null) return [];
    try {
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

function parseStoredCompletionReceiptValue(
  value: string,
): Pick<AppLocalCompletionReceipt, "id" | "observedAt"> | null {
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
      return null;
    }
    return { id: parsed.id, observedAt: parsed.observedAt };
  } catch {
    return null;
  }
}

function storageKeys(): ReadonlyArray<string> {
  const keys: string[] = [];
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (key !== null) keys.push(key);
  }
  return keys;
}
