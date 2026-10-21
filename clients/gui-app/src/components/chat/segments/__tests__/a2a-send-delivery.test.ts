import { describe, expect, it } from "vitest";
import type { AgentMessageDelivery } from "@traycer/protocol/persistence/epic/content-blocks";
import { a2aSendDeliveryView } from "@/components/chat/segments/a2a-send-delivery";

function delivery(state: AgentMessageDelivery["state"]): AgentMessageDelivery {
  return { targetHostId: "host-2", eventId: "evt-1", state };
}

describe("a2aSendDeliveryView", () => {
  it("queued: pending, badged, names the host", () => {
    const view = a2aSendDeliveryView(delivery("queued"), "Work Laptop");
    expect(view).toMatchObject({
      srLabel: "Queued message",
      badge: "queued",
      tone: "pending",
    });
    expect(view.note).toContain("Queued for Work Laptop");
  });

  it("delivered: no badge, says where it landed", () => {
    const view = a2aSendDeliveryView(delivery("delivered"), "Work Laptop");
    expect(view).toMatchObject({
      srLabel: "Delivered message",
      badge: null,
      tone: "delivered",
    });
    expect(view.note).toBe("Delivered on Work Laptop.");
  });

  it.each(["expired", "failed"] as const)(
    "%s: undelivered, badged, names the host",
    (state) => {
      const view = a2aSendDeliveryView(delivery(state), "Work Laptop");
      expect(view).toMatchObject({
        srLabel: "Undelivered message",
        badge: "not delivered",
        tone: "undelivered",
      });
      expect(view.note).toContain("Not delivered: Work Laptop");
    },
  );

  it("expired and failed read differently", () => {
    expect(a2aSendDeliveryView(delivery("expired"), "H").note).not.toBe(
      a2aSendDeliveryView(delivery("failed"), "H").note,
    );
  });

  it.each([null, ""])(
    "falls back to 'the other device' for host label %j",
    (label) => {
      for (const state of [
        "queued",
        "delivered",
        "expired",
        "failed",
      ] as const) {
        const view = a2aSendDeliveryView(delivery(state), label);
        expect(view.note).toContain("the other device");
      }
    },
  );
});
