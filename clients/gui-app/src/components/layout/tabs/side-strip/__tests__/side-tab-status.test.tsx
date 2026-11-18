import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { EMPTY_NOTIFICATION_INDICATOR_STATE } from "@/stores/notifications/notification-indicator-state";
import { sideTabStatusOf } from "../side-tab-status";

afterEach(() => cleanup());

// The strip's harness mounts no host directory, so the plane's coverage is
// always `indeterminate` there; a floor (agents known, a machine unseen) can
// only be handed to the status function directly.
describe("sideTabStatusOf", () => {
  const glyph = <span data-testid="glyph" />;

  it("shows the meter, with its floor mark, for one agent on a plane that misses a machine", () => {
    const status = sideTabStatusOf({
      indicator: EMPTY_NOTIFICATION_INDICATOR_STATE,
      agents: { turn: 1, background: 0, coverage: "unserved" },
      meterYields: false,
      glyph,
    });
    render(status.node);

    expect(status.yieldsToClose).toBe(false);
    expect(screen.getByTestId("side-tab-meter-floor")).not.toBeNull();
    expect(screen.queryByTestId("glyph")).toBeNull();
  });

  it("leaves a plane that misses a machine but has no agent to the glyph", () => {
    const status = sideTabStatusOf({
      indicator: EMPTY_NOTIFICATION_INDICATOR_STATE,
      agents: { turn: 0, background: 0, coverage: "unserved" },
      meterYields: false,
      glyph,
    });
    expect(status.yieldsToClose).toBe(true);
    expect(status.node).toBe(glyph);
  });
});
