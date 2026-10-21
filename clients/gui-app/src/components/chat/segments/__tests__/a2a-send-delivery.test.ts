import { describe, expect, it } from "vitest";
import type { AgentMessageDelivery } from "@traycer/protocol/persistence/epic/content-blocks";
import { a2aSendDeliveryView } from "@/components/chat/segments/a2a-send-delivery";

function delivery(state: AgentMessageDelivery["state"]): AgentMessageDelivery {
  return { targetHostId: "host-2", eventId: "evt-1", state };
}

describe("a2aSendDeliveryView", () => {
  it("queued: pending, badged, names the host", () => {
    const view = a2aSendDeliveryView(delivery("queued"), "Work Laptop");
    expect(view).toEqual({
      srLabel: "Unconfirmed message",
      badge: "unconfirmed",
      note: "Sent to Work Laptop. Shows delivered once Work Laptop confirms it.",
      tone: "pending",
    });
  });

  // A receiving host older than the delivered report accepts the message and
  // never confirms it, so its sender's card stays in this state for good
  // (traycerai/traycer#2421: a send from 1.5.2-staging.123 to a host on
  // 1.5.2-staging.116 was taken at once and still read "Queued for Linux. It
  // is delivered when Linux picks it up."). Nothing on the card may say the
  // message still waits to be taken or that it will be.
  it("queued: claims nothing an older receiving host never does", () => {
    const view = a2aSendDeliveryView(delivery("queued"), "Linux");
    for (const text of [view.srLabel, view.badge ?? "", view.note]) {
      expect(text).not.toMatch(/queued|picks it up|is delivered when/i);
    }
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
