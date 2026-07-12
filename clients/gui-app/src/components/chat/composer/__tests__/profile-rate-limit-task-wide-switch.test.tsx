import "../../../../../__tests__/test-browser-apis";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProfileRateLimitSwitchBanner } from "../profile-rate-limit-switch-banner";

/**
 * Task-wide rate-limit switch: when the limited profile pins more than one
 * chat of the task, the banner offers an explicit second option per
 * alternative - "Switch all N chats in this task to <profile>". The
 * task-wide callback fires ONLY from that option - never automatically -
 * and always alongside the per-session switch (the task includes this chat).
 */

const CURRENT = {
  profileId: "limited-uuid",
  accentDotId: "limited-uuid",
  label: "Limited profile",
  accentColor: null,
};
const ALTERNATIVE = {
  profileId: "fresh-uuid",
  accentDotId: "fresh-uuid",
  label: "Fresh profile",
  accentColor: null,
};

function renderBanner(input: {
  readonly affectedChatCount: number;
  readonly onSwitchProfile: (profileId: string | null) => void;
  readonly onSwitchProfileForTask: (profileId: string | null) => void;
}) {
  return render(
    <ProfileRateLimitSwitchBanner
      harnessId="claude"
      hardLimited
      current={CURRENT}
      alternatives={[ALTERNATIVE]}
      onSwitchProfile={input.onSwitchProfile}
      affectedChatCount={input.affectedChatCount}
      onSwitchProfileForTask={input.onSwitchProfileForTask}
      onDismiss={() => undefined}
    />,
  );
}

describe("rate-limit banner task-wide switch", () => {
  afterEach(() => cleanup());

  it("hides the task-wide option when only this chat is affected", () => {
    renderBanner({
      affectedChatCount: 1,
      onSwitchProfile: () => undefined,
      onSwitchProfileForTask: () => undefined,
    });
    expect(
      screen.queryByRole("button", {
        name: `Switch all 1 chats in this task to ${ALTERNATIVE.label}`,
      }),
    ).toBeNull();
    expect(screen.queryByText(/Switch all/)).toBeNull();
  });

  it("switches only this session from the per-session option", () => {
    const onSwitchProfile = vi.fn();
    const onSwitchProfileForTask = vi.fn();
    renderBanner({
      affectedChatCount: 3,
      onSwitchProfile,
      onSwitchProfileForTask,
    });

    expect(
      screen.getByRole("button", {
        name: `Switch all 3 chats in this task to ${ALTERNATIVE.label}`,
      }),
    ).not.toBeNull();
    fireEvent.click(
      screen.getByRole("button", {
        name: `Continue this session on ${ALTERNATIVE.label}`,
      }),
    );
    expect(onSwitchProfile).toHaveBeenCalledWith(ALTERNATIVE.profileId);
    expect(onSwitchProfileForTask).not.toHaveBeenCalled();
  });

  it("switches the whole task (this chat included) from the task-wide option", () => {
    const onSwitchProfile = vi.fn();
    const onSwitchProfileForTask = vi.fn();
    renderBanner({
      affectedChatCount: 2,
      onSwitchProfile,
      onSwitchProfileForTask,
    });

    fireEvent.click(
      screen.getByRole("button", {
        name: `Switch all 2 chats in this task to ${ALTERNATIVE.label}`,
      }),
    );
    expect(onSwitchProfile).toHaveBeenCalledWith(ALTERNATIVE.profileId);
    expect(onSwitchProfileForTask).toHaveBeenCalledWith(ALTERNATIVE.profileId);
  });
});
