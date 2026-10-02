import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { EpicSessionLifecycleBridge } from "@/providers/auth-lifecycle-bridge";
import { __getChatSessionRegistryForTests } from "@/lib/registries/chat-session-registry";
import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useAddHostDialogStore } from "@/stores/settings/add-host-dialog-store";
import { useProvidersFocusStore } from "@/stores/settings/providers-focus-store";
import { useSettingsHostScopeStore } from "@/stores/settings/settings-host-scope-store";
import { useWatchHostStore } from "@/stores/host-scope/watch-host-store";
import { useProfileCopyFlowStore } from "@/stores/settings/profile-copy-flow-store";
import {
  clearProfileCopyObservations,
  observeProfileCopyOutcome,
} from "@/hooks/providers/profile-copy/profile-copy-observations";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { createAppQueryClient } from "@/lib/query-client";
import {
  ATTEMPT_ID,
  DEST_HOST_ID,
  profileCopyAttempt,
  recordedOutcome,
} from "@/lib/profile-copy/__tests__/profile-copy-test-fixtures";

function resetAuth(
  status: "signed-out" | "signing-in" | "signed-in",
  email: string | null,
  userId: string | null,
): void {
  if (status === "signed-in" && email !== null && userId !== null) {
    useAuthStore.setState({
      status,
      profile: { userId, userName: email, email },
      contextMetadata: { userId, username: email },
    });
    return;
  }
  useAuthStore.setState({ status, profile: null, contextMetadata: null });
}

function armCopyDialog(): void {
  useProfileCopyFlowStore.getState().open({
    kind: "draft",
    destinationHostId: DEST_HOST_ID,
    attempt: profileCopyAttempt({}),
    profileName: "Work",
  });
  useProfileCopyFlowStore.getState().claimLogin({
    destinationHostId: DEST_HOST_ID,
    attemptId: ATTEMPT_ID,
  });
  useProfileCopyFlowStore.getState().recordDirectBlock(ATTEMPT_ID, {
    verb: "sign-in",
    revision: 1,
    reason: "adapter-not-admitted",
  });
}

describe("EpicSessionLifecycleBridge profile-copy teardown", () => {
  beforeEach(() => {
    resetAuth("signed-in", "alice@example.com", "user-alice");
    __getOpenEpicRegistryForTests().disposeAll();
    __getChatSessionRegistryForTests().disposeAll();
    useProfileCopyFlowStore.getState().reset();
    clearProfileCopyObservations();
  });

  afterEach(() => {
    cleanup();
    __getOpenEpicRegistryForTests().disposeAll();
    __getChatSessionRegistryForTests().disposeAll();
    resetAuth("signed-out", null, null);
    useSettingsHostScopeStore.getState().setScopedHostId(null);
    useWatchHostStore.setState({ scopedHostId: null });
    window.localStorage.clear();
    useAddHostDialogStore.getState().closeDialog();
    useProvidersFocusStore.getState().clearFocusHarnessId();
    useProvidersFocusStore.getState().clearFocusTab();
    useProfileCopyFlowStore.getState().reset();
    clearProfileCopyObservations();
    vi.restoreAllMocks();
  });

  it("resets the flow store and observations on userSwitched", () => {
    const queryClient = createAppQueryClient();
    const track = vi.spyOn(Analytics.getInstance(), "track");
    render(
      <EpicSessionLifecycleBridge>
        <div />
      </EpicSessionLifecycleBridge>,
    );
    armCopyDialog();
    observeProfileCopyOutcome(
      queryClient,
      recordedOutcome({ state: "signed-in", reason: null }),
    );
    expect(track).toHaveBeenCalledTimes(1);
    const session = useProfileCopyFlowStore.getState().session;

    act(() => {
      resetAuth("signed-in", "bob@example.com", "user-bob");
    });

    expect(useProfileCopyFlowStore.getState().view).toBeNull();
    expect(useProfileCopyFlowStore.getState().activeLogin).toBeNull();
    expect(useProfileCopyFlowStore.getState().directBlocks).toEqual({});
    expect(useProfileCopyFlowStore.getState().session).toBe(session);
    observeProfileCopyOutcome(
      queryClient,
      recordedOutcome({ state: "signed-in", reason: null }),
    );
    expect(
      track.mock.calls.filter(
        (call) => call[0] === AnalyticsEvent.ProfileCopyAttemptSettled,
      ),
    ).toHaveLength(2);
  });

  it("resets the flow store and observations on signedOut", () => {
    const queryClient = createAppQueryClient();
    const track = vi.spyOn(Analytics.getInstance(), "track");
    render(
      <EpicSessionLifecycleBridge>
        <div />
      </EpicSessionLifecycleBridge>,
    );
    armCopyDialog();
    observeProfileCopyOutcome(
      queryClient,
      recordedOutcome({ state: "signed-in", reason: null }),
    );
    expect(track).toHaveBeenCalledTimes(1);

    act(() => {
      resetAuth("signed-out", null, null);
    });

    expect(useProfileCopyFlowStore.getState().view).toBeNull();
    expect(useProfileCopyFlowStore.getState().activeLogin).toBeNull();
    expect(useProfileCopyFlowStore.getState().directBlocks).toEqual({});
    observeProfileCopyOutcome(
      queryClient,
      recordedOutcome({ state: "signed-in", reason: null }),
    );
    expect(
      track.mock.calls.filter(
        (call) => call[0] === AnalyticsEvent.ProfileCopyAttemptSettled,
      ),
    ).toHaveLength(2);
  });
});
