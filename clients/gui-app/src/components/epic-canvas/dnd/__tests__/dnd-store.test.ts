import { describe, expect, it } from "vitest";
import { readHeaderTabDragGhost } from "@/components/epic-canvas/dnd/dnd-store";
import { EMPTY_NOTIFICATION_INDICATOR_STATE } from "@/stores/notifications/notification-indicator-state";
import type { HeaderTabAppearance } from "@/stores/tabs/types";

/** The payload shape a header-tab draggable attaches to its dnd-kit `data`. */
function payloadWith(appearance: unknown): unknown {
  return {
    ghost: { appearance, indicatorState: EMPTY_NOTIFICATION_INDICATOR_STATE },
  };
}

describe("readHeaderTabDragGhost", () => {
  it("keeps a coloured tab's colour and icon through the drag payload", () => {
    // Typed as the real type: this is what catches the guard drifting from it.
    const appearance: HeaderTabAppearance = { color: "#12ab34", icon: "🚀" };

    expect(readHeaderTabDragGhost(payloadWith(appearance))?.appearance).toEqual(
      appearance,
    );
  });

  it("preserves an uncoloured, icon-less appearance instead of collapsing it to null", () => {
    const appearance: HeaderTabAppearance = { color: null, icon: null };

    expect(readHeaderTabDragGhost(payloadWith(appearance))?.appearance).toEqual(
      appearance,
    );
  });

  it("degrades a malformed appearance to null but still returns the ghost", () => {
    const ghost = readHeaderTabDragGhost(
      payloadWith({ color: 42, icon: null }),
    );

    expect(ghost).not.toBeNull();
    expect(ghost?.appearance).toBeNull();
    expect(ghost?.indicatorState).toEqual(EMPTY_NOTIFICATION_INDICATOR_STATE);
  });

  it("returns null when the payload carries no ghost", () => {
    expect(readHeaderTabDragGhost({})).toBeNull();
  });
});
