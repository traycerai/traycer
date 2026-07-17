import "../../../../__tests__/test-browser-apis";
import { beforeEach, describe, expect, it } from "vitest";
import {
  appLocalDisplayDeliveryKey,
  clearAppLocalDisplayReceipts,
  hasAppLocalDisplayReceipt,
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
});
