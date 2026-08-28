import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { anyTooltipHasText } from "@/components/ui/__tests__/tooltip-probe";
import {
  NotificationIndicatorIcon,
  type IndicatorRunningKind,
} from "@/components/notifications/notification-indicator-icon";
import type { NotificationIndicatorState } from "@/stores/notifications/notification-indicator-state";
import {
  contrastRatio,
  DARK_THEME_SURFACES,
  DESTRUCTIVE_FOREGROUND,
  LIGHT_THEME_SURFACES,
  SUCCESS_FOREGROUND,
} from "../../../../__tests__/contrast";

const DEFAULT_STATE = {
  unreadFailure: false,
  pendingFork: false,
  pendingApproval: false,
  pendingInterview: false,
  unreadDone: false,
};

afterEach(cleanup);

describe("<NotificationIndicatorIcon />", () => {
  it("renders status icons ahead of running, then running ahead of completion", () => {
    const { rerender } = renderIcon(
      {
        unreadFailure: true,
        pendingFork: true,
        pendingApproval: true,
        pendingInterview: true,
        unreadDone: false,
      },
      "turn",
    );

    expect(
      screen.getByTestId("indicator-failure-subject-1").getAttribute("class"),
    ).toContain("text-destructive");
    expect(
      screen.getByTestId("indicator-failure-subject-1").getAttribute("class"),
    ).toContain("lucide-message-square-x");
    expect(anyTooltipHasText("Task needs attention")).toBe(true);
    expect(screen.queryByTestId("indicator-activity-subject-1")).toBeNull();

    rerender(
      renderIconContent(
        {
          unreadFailure: false,
          pendingFork: true,
          pendingApproval: true,
          pendingInterview: true,
          unreadDone: true,
        },
        "turn",
      ),
    );
    expect(
      screen.getByTestId("indicator-fork-subject-1").getAttribute("class"),
    ).toContain("text-warning-foreground");
    expect(
      screen.getByTestId("indicator-fork-subject-1").getAttribute("class"),
    ).toContain("lucide-git-fork");
    rerender(
      renderIconContent(
        {
          unreadFailure: false,
          pendingFork: false,
          pendingApproval: true,
          pendingInterview: true,
          unreadDone: true,
        },
        "turn",
      ),
    );
    expect(
      screen.getByTestId("indicator-interview-subject-1").getAttribute("class"),
    ).toContain("lucide-message-square-question-mark");

    rerender(
      renderIconContent(
        {
          unreadFailure: false,
          pendingFork: false,
          pendingApproval: true,
          pendingInterview: false,
          unreadDone: true,
        },
        "turn",
      ),
    );
    expect(
      screen.getByTestId("indicator-approval-subject-1").getAttribute("class"),
    ).toContain("text-warning-foreground");
    expect(
      screen.getByTestId("indicator-approval-subject-1").getAttribute("class"),
    ).toContain("lucide-message-square-warning");

    rerender(
      renderIconContent(
        {
          unreadFailure: false,
          pendingFork: false,
          pendingApproval: false,
          pendingInterview: false,
          unreadDone: true,
        },
        "turn",
      ),
    );
    expect(screen.getByTestId("indicator-activity-subject-1")).toBeDefined();
    expect(screen.queryByTestId("indicator-done-subject-1")).toBeNull();

    rerender(
      renderIconContent(
        {
          unreadFailure: false,
          pendingFork: false,
          pendingApproval: false,
          pendingInterview: false,
          unreadDone: true,
        },
        false,
      ),
    );
    expect(
      screen.getByTestId("indicator-done-subject-1").getAttribute("class"),
    ).toContain("text-success-foreground");
    expect(
      screen.getByTestId("indicator-done-subject-1").getAttribute("class"),
    ).toContain("lucide-message-square-check");

    rerender(renderIconContent(DEFAULT_STATE, "turn"));
    expect(screen.getByTestId("indicator-activity-subject-1")).toBeDefined();

    rerender(
      <NotificationIndicatorIcon
        state={DEFAULT_STATE}
        running={false}
        subjectId="subject-1"
        testIdPrefix="indicator"
        className={undefined}
        style={undefined}
        runningTitle="Task activity in progress"
        defaultIcon={<span data-testid="default-icon" />}
        statusPresentation="message"
        agentSurface="gui"
      />,
    );
    expect(screen.getByTestId("default-icon")).toBeDefined();
  });

  it("keeps failure above a done tone retained from another descendant", () => {
    renderIcon(
      {
        unreadFailure: true,
        pendingFork: false,
        pendingApproval: false,
        pendingInterview: false,
        unreadDone: true,
      },
      false,
    );

    expect(screen.getByTestId("indicator-failure-subject-1")).toBeDefined();
    expect(screen.queryByTestId("indicator-done-subject-1")).toBeNull();
  });

  it("shows completion above a terminal-only failure", () => {
    renderIcon(
      {
        unreadFailure: true,
        unreadTerminalFailure: true,
        pendingFork: false,
        pendingApproval: false,
        pendingInterview: false,
        unreadDone: true,
      },
      false,
    );

    expect(
      screen.getByTestId("indicator-done-subject-1").getAttribute("class"),
    ).toContain("lucide-message-square-check");
    expect(screen.queryByTestId("indicator-failure-subject-1")).toBeNull();
  });

  it("shows a running turn above a historical terminal failure", () => {
    renderIcon(
      {
        unreadFailure: true,
        unreadTerminalFailure: true,
        pendingFork: false,
        pendingApproval: false,
        pendingInterview: false,
        unreadDone: false,
      },
      "turn",
    );

    expect(screen.getByTestId("indicator-activity-subject-1")).toBeDefined();
    expect(screen.queryByTestId("indicator-failure-subject-1")).toBeNull();
  });

  it("shows a chat failure above a coexisting terminal failure", () => {
    renderIcon(
      {
        unreadFailure: true,
        unreadNonTerminalFailure: true,
        unreadTerminalFailure: true,
        pendingFork: false,
        pendingApproval: false,
        pendingInterview: false,
        unreadDone: true,
      },
      false,
    );

    expect(
      screen.getByTestId("indicator-failure-subject-1").getAttribute("class"),
    ).toContain("lucide-message-square-x");
    expect(screen.queryByTestId("indicator-done-subject-1")).toBeNull();
  });

  it("keeps the chat glyph for a latest failure on a GUI surface", () => {
    renderIcon(
      {
        unreadFailure: true,
        unreadTerminalFailure: true,
        pendingFork: false,
        pendingApproval: false,
        pendingInterview: false,
        unreadDone: false,
      },
      false,
    );

    const failure = screen.getByTestId("indicator-failure-subject-1");
    expect(failure.getAttribute("class")).toContain("lucide-message-square-x");
    expect(failure.getAttribute("class")).not.toContain(
      "lucide-square-terminal",
    );
  });

  it("uses the terminal glyph for the same latest failure on a TUI surface", () => {
    render(
      <NotificationIndicatorIcon
        state={{
          unreadFailure: true,
          unreadTerminalFailure: true,
          pendingFork: false,
          pendingApproval: false,
          pendingInterview: false,
          unreadDone: false,
        }}
        running={false}
        subjectId="subject-1"
        testIdPrefix="indicator"
        className={undefined}
        style={undefined}
        runningTitle="Task activity in progress"
        defaultIcon={<span data-testid="default-icon" />}
        statusPresentation="message"
        agentSurface="tui"
      />,
    );

    const failure = screen.getByTestId("indicator-failure-subject-1");
    expect(failure.getAttribute("class")).toContain("lucide-square-terminal");
    expect(failure.getAttribute("class")).not.toContain(
      "lucide-message-square-x",
    );
  });

  it("renders the background tier as a muted waiting chat distinct from the turn spinner", () => {
    renderIcon(DEFAULT_STATE, "background");

    expect(
      screen.getByRole("status", {
        name: "Background activity — agent idle",
      }),
    ).toBeDefined();
    expect(
      screen.queryByRole("status", { name: "Task activity in progress" }),
    ).toBeNull();
    const glyph = screen.getByTestId("indicator-background-activity-subject-1");
    expect(glyph.tagName).toBe("svg");
    expect(glyph.getAttribute("class")).toContain(
      "lucide-message-square-clock",
    );
    expect(
      glyph.querySelector('circle[cx="16"][cy="16"][r="6"]'),
    ).not.toBeNull();
    expect(glyph.getAttribute("class")).toContain("size-3.5");
    expect(glyph.getAttribute("class")).toContain("text-muted-foreground");
  });

  it("renders status icons ahead of the background tier", () => {
    renderIcon({ ...DEFAULT_STATE, pendingApproval: true }, "background");

    expect(
      screen.getByRole("status", { name: "Task waiting for your approval" }),
    ).toBeDefined();
    expect(
      screen.queryByRole("status", {
        name: "Background activity — agent idle",
      }),
    ).toBeNull();
  });

  it("keeps the failure and completion status colors at >=3:1 against every theme preset's background and canvas", () => {
    for (const surfaces of Object.values(LIGHT_THEME_SURFACES)) {
      expect(
        contrastRatio(DESTRUCTIVE_FOREGROUND.light, surfaces.background),
      ).toBeGreaterThanOrEqual(3);
      expect(
        contrastRatio(DESTRUCTIVE_FOREGROUND.light, surfaces.canvas),
      ).toBeGreaterThanOrEqual(3);
      expect(
        contrastRatio(SUCCESS_FOREGROUND.light, surfaces.background),
      ).toBeGreaterThanOrEqual(3);
      expect(
        contrastRatio(SUCCESS_FOREGROUND.light, surfaces.canvas),
      ).toBeGreaterThanOrEqual(3);
    }
    for (const surfaces of Object.values(DARK_THEME_SURFACES)) {
      expect(
        contrastRatio(DESTRUCTIVE_FOREGROUND.dark, surfaces.background),
      ).toBeGreaterThanOrEqual(3);
      expect(
        contrastRatio(DESTRUCTIVE_FOREGROUND.dark, surfaces.canvas),
      ).toBeGreaterThanOrEqual(3);
      expect(
        contrastRatio(SUCCESS_FOREGROUND.dark, surfaces.background),
      ).toBeGreaterThanOrEqual(3);
      expect(
        contrastRatio(SUCCESS_FOREGROUND.dark, surfaces.canvas),
      ).toBeGreaterThanOrEqual(3);
    }
  });
});

function renderIcon(
  state: NotificationIndicatorState,
  running: IndicatorRunningKind,
) {
  return render(renderIconContent(state, running));
}

function renderIconContent(
  state: NotificationIndicatorState,
  running: IndicatorRunningKind,
) {
  return (
    <NotificationIndicatorIcon
      state={state}
      running={running}
      subjectId="subject-1"
      testIdPrefix="indicator"
      className={undefined}
      style={undefined}
      runningTitle="Task activity in progress"
      defaultIcon={<span data-testid="default-icon" />}
      statusPresentation="message"
      agentSurface="gui"
    />
  );
}
