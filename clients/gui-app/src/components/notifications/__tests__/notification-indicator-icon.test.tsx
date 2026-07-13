import "../../../../__tests__/test-browser-apis";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NotificationIndicatorIcon } from "@/components/notifications/notification-indicator-icon";

const DEFAULT_STATE = {
  unreadFailure: false,
  pendingPrompt: false,
  unreadDone: false,
};

describe("<NotificationIndicatorIcon />", () => {
  it("renders red and amber dots ahead of running, then running ahead of blue", () => {
    const { rerender } = renderIcon({
      unreadFailure: true,
      pendingPrompt: true,
      unreadDone: true,
    });

    expect(
      screen.getByTestId("indicator-failure-subject-1").className,
    ).toContain("text-red-500");
    expect(screen.getByTestId("indicator-failure-subject-1").textContent).toBe(
      "⠿",
    );
    expect(screen.getByTitle("Task needs attention")).toBeDefined();
    expect(screen.queryByTestId("indicator-activity-subject-1")).toBeNull();

    rerender(
      renderIconContent(
        {
          unreadFailure: false,
          pendingPrompt: true,
          unreadDone: true,
        },
        true,
      ),
    );
    expect(
      screen.getByTestId("indicator-prompt-subject-1").className,
    ).toContain("text-amber-500");
    expect(screen.getByTestId("indicator-prompt-subject-1").textContent).toBe(
      "⠿",
    );

    rerender(
      renderIconContent(
        {
          unreadFailure: false,
          pendingPrompt: false,
          unreadDone: true,
        },
        true,
      ),
    );
    expect(screen.getByTestId("indicator-activity-subject-1")).toBeDefined();
    expect(screen.queryByTestId("indicator-done-subject-1")).toBeNull();

    rerender(
      renderIconContent(
        {
          unreadFailure: false,
          pendingPrompt: false,
          unreadDone: true,
        },
        false,
      ),
    );
    expect(screen.getByTestId("indicator-done-subject-1").className).toContain(
      "text-blue-500",
    );
    expect(screen.getByTestId("indicator-done-subject-1").textContent).toBe(
      "⠿",
    );

    rerender(renderIconContent(DEFAULT_STATE, true));
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
      />,
    );
    expect(screen.getByTestId("default-icon")).toBeDefined();
  });
});

function renderIcon(state: {
  readonly unreadFailure: boolean;
  readonly pendingPrompt: boolean;
  readonly unreadDone: boolean;
}) {
  return render(renderIconContent(state, true));
}

function renderIconContent(
  state: {
    readonly unreadFailure: boolean;
    readonly pendingPrompt: boolean;
    readonly unreadDone: boolean;
  },
  running: boolean,
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
    />
  );
}
