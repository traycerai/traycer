import {
  appLocalNotificationDisplayReceiptKey,
  appLocalNotificationDisplayReceiptPrefix,
} from "@/lib/persist";

export interface AppLocalDisplayReceiptVersion {
  readonly userId: string;
  readonly notificationId: string;
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
  return (
    window.localStorage.getItem(
      appLocalNotificationDisplayReceiptKey(version),
    ) === "1"
  );
}

export function recordAppLocalDisplayReceipt(
  version: AppLocalDisplayReceiptVersion,
): void {
  window.localStorage.setItem(
    appLocalNotificationDisplayReceiptKey(version),
    "1",
  );
}

export function clearAppLocalDisplayReceipts(userId: string): void {
  const prefix = `${appLocalNotificationDisplayReceiptPrefix(userId)}:`;
  const keys: string[] = [];
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (key !== null && key.startsWith(prefix)) keys.push(key);
  }
  keys.forEach((key) => window.localStorage.removeItem(key));
}
