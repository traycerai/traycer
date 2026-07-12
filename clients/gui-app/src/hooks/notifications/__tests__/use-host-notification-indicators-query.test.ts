import { describe, expect, it } from "vitest";
import { HOST_NOTIFICATIONS_INDICATOR_BATCH_CAP } from "@traycer/protocol/host/notifications/contracts";
import { indicatorRequests } from "@/hooks/notifications/use-host-notification-indicators-query";

describe("indicatorRequests", () => {
  it("deduplicates, sorts, and chunks visible surface ids at the host cap", () => {
    const epicIds = Array.from(
      { length: HOST_NOTIFICATIONS_INDICATOR_BATCH_CAP + 1 },
      (_value, index) => `epic-${String(index).padStart(3, "0")}`,
    );
    const requests = indicatorRequests(
      [...epicIds, "epic-000"],
      ["chat-b", "chat-a"],
    );

    expect(requests).toHaveLength(2);
    expect(requests[0].epicIds).toHaveLength(
      HOST_NOTIFICATIONS_INDICATOR_BATCH_CAP,
    );
    expect(requests[1].epicIds).toEqual(["epic-500"]);
    expect(requests[0].chatIds).toEqual(["chat-a", "chat-b"]);
    expect(requests[1].chatIds).toEqual([]);
  });
});
