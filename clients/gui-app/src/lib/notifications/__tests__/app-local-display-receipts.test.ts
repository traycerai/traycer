import "../../../../__tests__/test-browser-apis";
import { beforeEach, describe, expect, it } from "vitest";
import {
  APP_LOCAL_DISPLAY_RECEIPT_NOTIFICATION_CAP,
  APP_LOCAL_DISPLAY_RECEIPT_VERSION_CAP,
  appLocalDisplayDeliveryKey,
  captureAppLocalDisplayReceiptSession,
  clearAppLocalDisplayReceipts,
  hasAppLocalDisplayReceipt,
  isAppLocalDisplayReceiptSessionCurrent,
  recordAppLocalDisplayReceipt,
  type AppLocalDisplayReceiptVersion,
} from "@/lib/notifications/app-local-display-receipts";

function version(
  userId: string,
  notificationId: string,
  updatedAt: number,
): AppLocalDisplayReceiptVersion {
  return { userId, notificationId, updatedAt };
}

function receiptKeysForUser(userId: string): ReadonlyArray<string> {
  const prefix = `traycer-gui-app:app-local-notification-display-receipt:${userId}:`;
  return Array.from({ length: window.localStorage.length }, (_, index) =>
    window.localStorage.key(index),
  ).filter((key): key is string => key !== null && key.startsWith(prefix));
}

describe("app-local display receipts", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("persists an exact notification version independently", () => {
    const target = version("user-1", "host.error:transport", 42);

    expect(hasAppLocalDisplayReceipt(target)).toBe(false);
    recordAppLocalDisplayReceipt(target);

    expect(hasAppLocalDisplayReceipt(target)).toBe(true);
    expect(hasAppLocalDisplayReceipt({ ...target, updatedAt: 43 })).toBe(false);
    expect(appLocalDisplayDeliveryKey(target)).toContain(
      "host.error%3Atransport:42",
    );
  });

  it("clears only the selected user's receipts", () => {
    const first = version("user-1", "n-1", 1);
    const second = version("user-2", "n-1", 1);
    recordAppLocalDisplayReceipt(first);
    recordAppLocalDisplayReceipt(second);

    clearAppLocalDisplayReceipts("user-1");

    expect(hasAppLocalDisplayReceipt(first)).toBe(false);
    expect(hasAppLocalDisplayReceipt(second)).toBe(true);
  });

  it("invalidates an in-flight receipt session when that user's receipts clear", () => {
    const session = captureAppLocalDisplayReceiptSession("user-1");

    clearAppLocalDisplayReceipts("user-1");

    expect(isAppLocalDisplayReceiptSessionCurrent(session)).toBe(false);
    expect(
      isAppLocalDisplayReceiptSessionCurrent(
        captureAppLocalDisplayReceiptSession("user-1"),
      ),
    ).toBe(true);
  });

  it("bounds versions without treating another notification's receipt as evidence", () => {
    for (
      let updatedAt = 1;
      updatedAt <= APP_LOCAL_DISPLAY_RECEIPT_VERSION_CAP + 2;
      updatedAt += 1
    ) {
      recordAppLocalDisplayReceipt(version("user-1", "recurring", updatedAt));
    }

    const exactPrefix =
      "traycer-gui-app:app-local-notification-display-receipt:user-1:recurring:";
    const exactKeys = receiptKeysForUser("user-1").filter((key) =>
      key.startsWith(exactPrefix),
    );
    expect(exactKeys).toHaveLength(APP_LOCAL_DISPLAY_RECEIPT_VERSION_CAP);
    expect(hasAppLocalDisplayReceipt(version("user-1", "recurring", 1))).toBe(
      true,
    );
    expect(
      hasAppLocalDisplayReceipt(
        version(
          "user-1",
          "recurring",
          APP_LOCAL_DISPLAY_RECEIPT_VERSION_CAP + 2,
        ),
      ),
    ).toBe(true);
    expect(
      hasAppLocalDisplayReceipt(version("user-1", "new-notification", 1)),
    ).toBe(false);
    expect(
      hasAppLocalDisplayReceipt(
        version(
          "user-1",
          "recurring",
          APP_LOCAL_DISPLAY_RECEIPT_VERSION_CAP + 3,
        ),
      ),
    ).toBe(false);
  });

  it("bounds the number of retained notification IDs without false positives", () => {
    for (
      let index = 0;
      index <= APP_LOCAL_DISPLAY_RECEIPT_NOTIFICATION_CAP;
      index += 1
    ) {
      recordAppLocalDisplayReceipt(
        version("user-1", `notification-${index}`, index + 1),
      );
    }

    expect(receiptKeysForUser("user-1")).toHaveLength(
      APP_LOCAL_DISPLAY_RECEIPT_NOTIFICATION_CAP,
    );
    expect(
      hasAppLocalDisplayReceipt(version("user-1", "notification-0", 1)),
    ).toBe(false);
    expect(
      hasAppLocalDisplayReceipt(version("user-1", "notification-1", 2)),
    ).toBe(true);
    expect(
      hasAppLocalDisplayReceipt(
        version(
          "user-1",
          `notification-${APP_LOCAL_DISPLAY_RECEIPT_NOTIFICATION_CAP}`,
          APP_LOCAL_DISPLAY_RECEIPT_NOTIFICATION_CAP + 1,
        ),
      ),
    ).toBe(true);
  });
});
