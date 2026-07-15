import "../../../../../__tests__/test-browser-apis";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProfileRateLimitSwitchBanner } from "../profile-rate-limit-switch-banner";
import { createComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";
import { commitProfileSelection } from "@/stores/composer/commit-selection";
import { useComposerHarnessMemoryStore } from "@/stores/composer/composer-harness-memory-store";

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
  beforeEach(() => {
    useComposerHarnessMemoryStore.getState().resetForTests();
  });

  afterEach(() => {
    cleanup();
    useComposerHarnessMemoryStore.getState().resetForTests();
  });

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

  it("preserves the session's configured model and reasoning when switching profiles", () => {
    useComposerHarnessMemoryStore.getState().record({
      harnessId: "claude",
      model: "opus-4",
      permissionMode: "supervised",
      reasoningEffort: "low",
      serviceTier: null,
      agentMode: "regular",
      profileId: ALTERNATIVE.profileId,
    });
    const store = createComposerToolbarStore({
      seedKey: "rate-limit-banner",
      values: {
        permission: "supervised",
        selection: {
          harnessId: "claude",
          modelSlug: "sonnet-4.5",
          profileId: CURRENT.profileId,
        },
        reasoning: "high",
        serviceTier: "",
        agentMode: "regular",
      },
      onSettingsChange: null,
      tuiOnly: false,
    });
    renderBanner({
      affectedChatCount: 1,
      onSwitchProfile: (profileId) => commitProfileSelection(store, profileId),
      onSwitchProfileForTask: () => undefined,
    });

    fireEvent.click(
      screen.getByRole("button", {
        name: `Continue this session on ${ALTERNATIVE.label}`,
      }),
    );

    expect(store.getState().selection).toEqual({
      harnessId: "claude",
      modelSlug: "sonnet-4.5",
      profileId: ALTERNATIVE.profileId,
    });
    expect(store.getState().reasoning).toBe("high");
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
