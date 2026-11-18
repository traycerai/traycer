import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  NotificationIndicatorIcon,
  type IndicatorRunningKind,
} from "@/components/notifications/notification-indicator-icon";
import type { AgentNotificationSurface } from "@/components/notifications/notification-indicator-tones";
import type { NotificationIndicatorState } from "@/stores/notifications/notification-indicator-state";

/**
 * `NotificationIndicatorIcon`'s per-surface split: every state draws through
 * the shared `StatusGlyph`, and the ONE place a surface still changes the
 * glyph is a resolved terminal failure (`terminalFailureTone`) - the TUI
 * surface keeps its own TerminalSquare icon there, distinct from the GUI
 * surface's chat MessageSquareX. A non-terminal (still-live) failure ignores
 * the surface entirely and always draws the plain chat glyph.
 */

const CLEAN_STATE: NotificationIndicatorState = {
  unreadFailure: false,
  pendingFork: false,
  pendingApproval: false,
  pendingInterview: false,
  unreadDone: false,
};

afterEach(cleanup);

function renderIcon(input: {
  readonly state: NotificationIndicatorState;
  readonly running: IndicatorRunningKind;
  readonly agentSurface: AgentNotificationSurface;
}) {
  return render(
    <NotificationIndicatorIcon
      state={input.state}
      running={input.running}
      activityCoverage="indeterminate"
      subjectId="subject-1"
      testIdPrefix="indicator"
      className={undefined}
      style={undefined}
      runningTitle="Task activity in progress"
      defaultIcon={<span data-testid="default-icon" />}
      agentSurface={input.agentSurface}
    />,
  );
}

describe("<NotificationIndicatorIcon /> terminal failure surface split", () => {
  it("draws a resolved terminal failure as the plain chat glyph on the GUI surface", () => {
    renderIcon({
      state: {
        ...CLEAN_STATE,
        unreadFailure: true,
        unreadTerminalFailure: true,
      },
      running: false,
      agentSurface: "gui",
    });
    const glyph = screen.getByTestId("indicator-failure-subject-1");
    expect(glyph.getAttribute("class")).toContain("lucide-message-square-x");
    expect(glyph.getAttribute("data-status-glyph")).toBe("failure");
  });

  it("draws a resolved terminal failure as the TerminalSquare glyph on the TUI surface", () => {
    renderIcon({
      state: {
        ...CLEAN_STATE,
        unreadFailure: true,
        unreadTerminalFailure: true,
      },
      running: false,
      agentSurface: "tui",
    });
    const glyph = screen.getByTestId("indicator-failure-subject-1");
    expect(glyph.getAttribute("class")).toContain("lucide-square-terminal");
    // Same testId and tone-id as the GUI glyph - only the icon differs.
    expect(glyph.getAttribute("data-status-glyph")).toBe("failure");
    expect(glyph.getAttribute("class")).toContain("text-destructive");
  });

  it("ignores the surface for a still-live (non-terminal) failure", () => {
    for (const agentSurface of ["gui", "tui"] as const) {
      renderIcon({
        state: { ...CLEAN_STATE, unreadFailure: true },
        running: false,
        agentSurface,
      });
      const glyph = screen.getByTestId("indicator-failure-subject-1");
      expect(glyph.getAttribute("class")).toContain("lucide-message-square-x");
      cleanup();
    }
  });
});
