import "../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import { ComposerRunSettingsPersistLifecycleBridge } from "@/providers/composer-run-settings-persist-lifecycle-bridge";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useComposerRunSettingsStore } from "@/stores/composer/composer-run-settings-store";
import { composerRunSettingsKey } from "@/lib/persist";

const ALICE_SETTINGS: ChatRunSettings = {
  harnessId: "codex",
  model: "gpt-5-codex",
  permissionMode: "supervised",
  reasoningEffort: null,
  serviceTier: null,
  agentMode: "regular",
  profileId: null,
};

const BOB_SETTINGS: ChatRunSettings = {
  harnessId: "claude",
  model: "sonnet-4.5",
  permissionMode: "full_access",
  reasoningEffort: "high",
  serviceTier: "flex",
  agentMode: "epic",
  profileId: null,
};

function resetAuth(
  status: "signed-out" | "signing-in" | "signed-in",
  email: string | null,
): void {
  if (status === "signed-in" && email !== null) {
    useAuthStore.setState({
      status,
      profile: { userId: email, userName: email, email },
      contextMetadata: { userId: email, username: email },
    });
    return;
  }
  useAuthStore.setState({ status, profile: null, contextMetadata: null });
}

function resetComposerRunSettingsStore(): void {
  useComposerRunSettingsStore.persist.setOptions({
    name: composerRunSettingsKey(null),
  });
  useComposerRunSettingsStore.getState().resetForTests();
}

function persistSnapshot(
  email: string | null,
  settings: ChatRunSettings,
): void {
  window.localStorage.setItem(
    composerRunSettingsKey(email),
    JSON.stringify({
      state: {
        globalLastRunSettings: settings,
        epicRunSettingsByEpicId: {},
      },
      version: 1,
    }),
  );
}

describe("<ComposerRunSettingsPersistLifecycleBridge />", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetAuth("signed-out", null);
    resetComposerRunSettingsStore();
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    resetAuth("signed-out", null);
    resetComposerRunSettingsStore();
  });

  it("retargets to the signed-in user's composer bucket", async () => {
    persistSnapshot("alice@example.com", ALICE_SETTINGS);
    resetAuth("signed-in", "alice@example.com");

    render(
      <ComposerRunSettingsPersistLifecycleBridge>
        <div />
      </ComposerRunSettingsPersistLifecycleBridge>,
    );

    await waitFor(() => {
      expect(useComposerRunSettingsStore.persist.getOptions().name).toBe(
        composerRunSettingsKey("alice@example.com"),
      );
      expect(
        useComposerRunSettingsStore.getState().globalLastRunSettings,
      ).toEqual(ALICE_SETTINGS);
    });
  });

  it("loads the second user's bucket without leaking first user state", async () => {
    persistSnapshot("alice@example.com", ALICE_SETTINGS);
    persistSnapshot("bob@example.com", BOB_SETTINGS);

    render(
      <ComposerRunSettingsPersistLifecycleBridge>
        <div />
      </ComposerRunSettingsPersistLifecycleBridge>,
    );

    act(() => {
      resetAuth("signed-in", "alice@example.com");
    });

    await waitFor(() => {
      expect(
        useComposerRunSettingsStore.getState().globalLastRunSettings,
      ).toEqual(ALICE_SETTINGS);
    });

    act(() => {
      resetAuth("signed-in", "bob@example.com");
    });

    await waitFor(() => {
      expect(useComposerRunSettingsStore.persist.getOptions().name).toBe(
        composerRunSettingsKey("bob@example.com"),
      );
      expect(
        useComposerRunSettingsStore.getState().globalLastRunSettings,
      ).toEqual(BOB_SETTINGS);
    });
  });

  it("signed-out clears the current bucket and resets to anonymous", async () => {
    persistSnapshot("alice@example.com", ALICE_SETTINGS);
    const clearStorageSpy = vi.spyOn(
      useComposerRunSettingsStore.persist,
      "clearStorage",
    );

    render(
      <ComposerRunSettingsPersistLifecycleBridge>
        <div />
      </ComposerRunSettingsPersistLifecycleBridge>,
    );

    act(() => {
      resetAuth("signed-in", "alice@example.com");
    });

    await waitFor(() => {
      expect(useComposerRunSettingsStore.persist.getOptions().name).toBe(
        composerRunSettingsKey("alice@example.com"),
      );
    });

    clearStorageSpy.mockClear();

    act(() => {
      resetAuth("signed-out", null);
    });

    await waitFor(() => {
      expect(clearStorageSpy).toHaveBeenCalledTimes(1);
      expect(
        window.localStorage.getItem(
          composerRunSettingsKey("alice@example.com"),
        ),
      ).toBeNull();
      expect(useComposerRunSettingsStore.persist.getOptions().name).toBe(
        composerRunSettingsKey(null),
      );
      expect(
        useComposerRunSettingsStore.getState().globalLastRunSettings,
      ).toBeNull();
    });

    clearStorageSpy.mockRestore();
  });
});
