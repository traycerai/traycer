import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { anyTooltipHasText } from "@/components/ui/__tests__/tooltip-probe";
import {
  NotificationIndicatorIcon,
  UNKNOWN_ACTIVITY_TITLE,
} from "@/components/notifications/notification-indicator-icon";
import type { NotificationIndicatorState } from "@/stores/notifications/notification-indicator-state";
import type { AgentActivityCoverage } from "@/lib/agent-activity";
import type { IndicatorRunningKind } from "@/components/notifications/notification-indicator-icon";

/**
 * `AgentActivityCoverage` (lane 9 item 1), rendering half.
 *
 * The `"unserved"` arm renders the unknown glyph ONLY in the idle slot - the
 * one place a producer has said NOTHING - and every other tier a producer DID
 * report must still win over it. That precedence is the whole defect: folding
 * "we don't know" into a fourth `running` member would put it ahead of a real
 * fact.
 */

const CLEAN_STATE: NotificationIndicatorState = {
  unreadFailure: false,
  pendingFork: false,
  pendingApproval: false,
  pendingInterview: false,
  unreadDone: false,
};

afterEach(cleanup);

function renderIcon(
  state: NotificationIndicatorState,
  running: IndicatorRunningKind,
  activityCoverage: AgentActivityCoverage,
) {
  return render(
    <NotificationIndicatorIcon
      state={state}
      running={running}
      activityCoverage={activityCoverage}
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
}

describe("<NotificationIndicatorIcon /> activityCoverage", () => {
  it("renders the unknown glyph instead of defaultIcon when unserved and otherwise idle", () => {
    renderIcon(CLEAN_STATE, false, "unserved");

    expect(screen.queryByTestId("default-icon")).toBeNull();
    expect(
      screen.getByTestId("indicator-unknown-activity-subject-1"),
    ).toBeDefined();
    expect(anyTooltipHasText(UNKNOWN_ACTIVITY_TITLE)).toBe(true);
    expect(
      screen.getByRole("status", { name: UNKNOWN_ACTIVITY_TITLE }),
    ).toBeDefined();
  });

  it("does not displace an attention tone", () => {
    renderIcon({ ...CLEAN_STATE, pendingApproval: true }, false, "unserved");

    expect(
      screen.getByRole("status", { name: "Task waiting for your approval" }),
    ).toBeDefined();
    expect(
      screen.queryByTestId("indicator-unknown-activity-subject-1"),
    ).toBeNull();
  });

  it("does not displace a running turn", () => {
    renderIcon(CLEAN_STATE, "turn", "unserved");

    expect(screen.getByTestId("indicator-activity-subject-1")).toBeDefined();
    expect(
      screen.queryByTestId("indicator-unknown-activity-subject-1"),
    ).toBeNull();
  });

  it("does not displace background activity", () => {
    renderIcon(CLEAN_STATE, "background", "unserved");

    expect(
      screen.getByTestId("indicator-background-activity-subject-1"),
    ).toBeDefined();
    expect(
      screen.queryByTestId("indicator-unknown-activity-subject-1"),
    ).toBeNull();
  });

  it("does not displace an unread completion", () => {
    renderIcon({ ...CLEAN_STATE, unreadDone: true }, false, "unserved");

    expect(screen.getByTestId("indicator-done-subject-1")).toBeDefined();
    expect(
      screen.queryByTestId("indicator-unknown-activity-subject-1"),
    ).toBeNull();
  });

  it("does not displace a terminal failure tone", () => {
    renderIcon(
      {
        ...CLEAN_STATE,
        unreadFailure: true,
        unreadTerminalFailure: true,
      },
      false,
      "unserved",
    );

    expect(screen.getByTestId("indicator-failure-subject-1")).toBeDefined();
    expect(
      screen.queryByTestId("indicator-unknown-activity-subject-1"),
    ).toBeNull();
  });

  it("renders defaultIcon, unchanged, when indeterminate", () => {
    renderIcon(CLEAN_STATE, false, "indeterminate");

    expect(screen.getByTestId("default-icon")).toBeDefined();
    expect(
      screen.queryByTestId("indicator-unknown-activity-subject-1"),
    ).toBeNull();
  });
});
