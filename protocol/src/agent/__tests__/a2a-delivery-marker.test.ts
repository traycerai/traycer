import { describe, expect, it } from "vitest";
import {
  extractAgentDeliveryMarkerFromTaskNotification,
  extractAgentDeliveryMarkerUnanchored,
  formatAgentDeliveryMarker,
} from "../a2a-delivery-marker";

describe("formatAgentDeliveryMarker / extract round-trip", () => {
  it("round-trips a delivery id through format + unanchored extract", () => {
    const formatted = formatAgentDeliveryMarker({
      deliveryId: "deliv-abc-123",
    });
    expect(formatted).toBe(
      '[traycer:delivery-marker] deliveryId="deliv-abc-123"',
    );
    expect(extractAgentDeliveryMarkerUnanchored(formatted)).toEqual({
      deliveryId: "deliv-abc-123",
    });
  });

  it("finds the marker unanchored — not only at byte zero of content", () => {
    const marker = formatAgentDeliveryMarker({ deliveryId: "deliv-nested" });
    const content = `preamble noise\nmore noise\n${marker}\ntrailing`;
    expect(content.indexOf("[traycer:delivery-marker]")).toBeGreaterThan(0);
    expect(extractAgentDeliveryMarkerUnanchored(content)).toEqual({
      deliveryId: "deliv-nested",
    });
  });

  it("extracts the marker from inside a <task-notification> body only", () => {
    const marker = formatAgentDeliveryMarker({ deliveryId: "deliv-task" });
    const content = [
      "outer transcript noise before the wrapper",
      `<task-notification source="monitor">`,
      "  intro line the marker is not at body byte zero",
      `  ${marker}`,
      "  rest of notification",
      `</task-notification>`,
      "outer noise after",
    ].join("\n");

    expect(extractAgentDeliveryMarkerFromTaskNotification(content)).toEqual({
      deliveryId: "deliv-task",
    });
  });

  it("does not treat a marker outside <task-notification> as a task-body hit", () => {
    const marker = formatAgentDeliveryMarker({ deliveryId: "deliv-outside" });
    const content = `${marker}\n<task-notification>no marker here</task-notification>`;
    expect(extractAgentDeliveryMarkerFromTaskNotification(content)).toBeNull();
    // Unanchored whole-content extract still finds it (different helper).
    expect(extractAgentDeliveryMarkerUnanchored(content)).toEqual({
      deliveryId: "deliv-outside",
    });
  });

  it("returns null for missing or empty markers", () => {
    expect(extractAgentDeliveryMarkerUnanchored("no marker here")).toBeNull();
    expect(
      extractAgentDeliveryMarkerUnanchored(
        '[traycer:delivery-marker] deliveryId=""',
      ),
    ).toBeNull();
    expect(
      extractAgentDeliveryMarkerFromTaskNotification(
        "<task-notification></task-notification>",
      ),
    ).toBeNull();
  });
});
