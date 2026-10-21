import { describe, expect, it } from "vitest";
import type { AgentMessageDelivery } from "@traycer/protocol/persistence/epic/content-blocks";
import { a2aSendDeliveryView } from "@/components/chat/segments/a2a-send-delivery";

function delivery(
  state: AgentMessageDelivery["state"],
  targetHostOffline: boolean,
): AgentMessageDelivery {
  return { targetHostId: "host-2", eventId: "evt-1", state, targetHostOffline };
}

describe("a2aSendDeliveryView", () => {
  // The host reports failures only (traycer#2421): a send nothing has failed
  // is the plain sent card, whatever host build stamped it.
  it.each(["queued", "delivered"] as const)(
    "%s to a host not seen offline: the plain sent card",
    (state) => {
      expect(a2aSendDeliveryView(delivery(state, false), "Work Laptop")).toBe(
        null,
      );
    },
  );

  it("queued to a host seen offline: sent, unbadged, says the host looked offline", () => {
    const view = a2aSendDeliveryView(delivery("queued", true), "Work Laptop");
    expect(view).toEqual({
      srLabel: "Sent message",
      badge: null,
      note: "Sent. Work Laptop looked offline; it gets this if it is back online within 24 hours.",
      tone: "sent",
    });
  });

  it.each([false, true])(
    "expired and failed read as not delivered whatever the offline hint (%s)",
    (offline) => {
      for (const state of ["expired", "failed"] as const) {
        const view = a2aSendDeliveryView(
          delivery(state, offline),
          "Work Laptop",
        );
        expect(view).toMatchObject({
          srLabel: "Undelivered message",
          badge: "not delivered",
          tone: "undelivered",
        });
        expect(view?.note).toContain("Not delivered: Work Laptop");
      }
    },
  );

  it("expired and failed read differently", () => {
    expect(a2aSendDeliveryView(delivery("expired", false), "H")?.note).not.toBe(
      a2aSendDeliveryView(delivery("failed", false), "H")?.note,
    );
  });

  it.each([null, ""])(
    "falls back to 'the other device' for host label %j",
    (label) => {
      for (const [state, offline] of [
        ["queued", true],
        ["expired", false],
        ["failed", false],
      ] as const) {
        const view = a2aSendDeliveryView(delivery(state, offline), label);
        expect(view?.note).toContain("the other device");
      }
    },
  );
});
