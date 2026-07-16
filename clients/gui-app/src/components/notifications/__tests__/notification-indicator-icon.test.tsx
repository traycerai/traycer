import "../../../../__tests__/test-browser-apis";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  NotificationIndicatorIcon,
  type IndicatorRunningKind,
} from "@/components/notifications/notification-indicator-icon";
import {
  contrastRatio,
  DARK_THEME_SURFACES,
  DESTRUCTIVE_FOREGROUND,
  LIGHT_THEME_SURFACES,
  SUCCESS_FOREGROUND,
} from "../../../../__tests__/contrast";

const DEFAULT_STATE = {
  unreadFailure: false,
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
        pendingApproval: true,
        pendingInterview: true,
        unreadDone: true,
      },
      "turn",
    );

    expect(
      screen.getByTestId("indicator-failure-subject-1").getAttribute("class"),
    ).toContain("text-destructive");
    expect(
      screen.getByTestId("indicator-failure-subject-1").getAttribute("class"),
    ).toContain("lucide-message-square-x");
    expect(screen.getByTitle("Task needs attention")).toBeDefined();
    expect(screen.queryByTestId("indicator-activity-subject-1")).toBeNull();

    rerender(
      renderIconContent(
        {
          unreadFailure: false,
          pendingApproval: true,
          pendingInterview: true,
          unreadDone: true,
        },
        "turn",
      ),
    );
    expect(
      screen.getByTestId("indicator-interview-subject-1").getAttribute("class"),
    ).toContain("text-warning-foreground");
    expect(
      screen.getByTestId("indicator-interview-subject-1").getAttribute("class"),
    ).toContain("lucide-message-square-question-mark");

    rerender(
      renderIconContent(
        {
          unreadFailure: false,
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
        backgroundRunningTitle={undefined}
        defaultIcon={<span data-testid="default-icon" />}
        statusPresentation="message"
      />,
    );
    expect(screen.getByTestId("default-icon")).toBeDefined();
  });

  it("renders the background tier muted and titled distinctly from the turn spinner", () => {
    renderIcon(DEFAULT_STATE, "background");

    expect(
      screen.getByRole("status", { name: "Background tasks running" }),
    ).toBeDefined();
    expect(
      screen.queryByRole("status", { name: "Task activity in progress" }),
    ).toBeNull();
    // Class assertion needs the inner spinner node, which carries the tier's
    // muted styling; the role query above owns the presence contract.
    expect(
      screen
        .getByTestId("indicator-background-activity-subject-1")
        .getAttribute("class"),
    ).toContain("text-muted-foreground");
  });

  it("renders status icons ahead of the background tier", () => {
    renderIcon({ ...DEFAULT_STATE, pendingApproval: true }, "background");

    expect(
      screen.getByRole("status", { name: "Task waiting for your approval" }),
    ).toBeDefined();
    expect(
      screen.queryByRole("status", { name: "Background tasks running" }),
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
  state: {
    readonly unreadFailure: boolean;
    readonly pendingApproval: boolean;
    readonly pendingInterview: boolean;
    readonly unreadDone: boolean;
  },
  running: IndicatorRunningKind,
) {
  return render(renderIconContent(state, running));
}

function renderIconContent(
  state: {
    readonly unreadFailure: boolean;
    readonly pendingApproval: boolean;
    readonly pendingInterview: boolean;
    readonly unreadDone: boolean;
  },
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
      backgroundRunningTitle="Background tasks running"
      defaultIcon={<span data-testid="default-icon" />}
      statusPresentation="message"
    />
  );
}
