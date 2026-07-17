import "../../../../__tests__/test-browser-apis";
import { beforeEach, describe, expect, it } from "vitest";
import {
  APP_LOCAL_DISPLAY_RECEIPTS_PER_USER_CAP,
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

  it("bounds exact receipts while a monotonic floor suppresses compacted versions", () => {
    for (
      let updatedAt = 1;
      updatedAt <= APP_LOCAL_DISPLAY_RECEIPTS_PER_USER_CAP + 2;
      updatedAt += 1
    ) {
      recordAppLocalDisplayReceipt(version("user-1", "recurring", updatedAt));
    }

    const exactPrefix =
      "traycer-gui-app:app-local-notification-display-receipt:user-1:";
    const exactKeys = Array.from(
      { length: window.localStorage.length },
      (_, index) => window.localStorage.key(index),
    ).filter(
      (key): key is string => key !== null && key.startsWith(exactPrefix),
    );
    expect(exactKeys).toHaveLength(APP_LOCAL_DISPLAY_RECEIPTS_PER_USER_CAP);
    expect(hasAppLocalDisplayReceipt(version("user-1", "recurring", 1))).toBe(
      true,
    );
    expect(
      hasAppLocalDisplayReceipt(
        version(
          "user-1",
          "recurring",
          APP_LOCAL_DISPLAY_RECEIPTS_PER_USER_CAP + 2,
        ),
      ),
    ).toBe(true);
    expect(
      hasAppLocalDisplayReceipt(
        version(
          "user-1",
          "new-notification",
          APP_LOCAL_DISPLAY_RECEIPTS_PER_USER_CAP + 3,
        ),
      ),
    ).toBe(false);
  });
});
