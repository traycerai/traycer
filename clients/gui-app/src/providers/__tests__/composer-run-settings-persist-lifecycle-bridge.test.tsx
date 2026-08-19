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

const ALICE_EMAIL = "alice@example.com";
const BOB_EMAIL = "bob@example.com";
const ALICE_ID = `user:${ALICE_EMAIL}`;
const BOB_ID = `user:${BOB_EMAIL}`;

function resetAuth(
  status: "signed-out" | "signing-in" | "signed-in",
  email: string | null,
): void {
  if (status === "signed-in" && email !== null) {
    // userId and email deliberately DIFFER: a fixture that equates them
    // cannot detect email-keyed scoping.
    const userId = `user:${email}`;
    useAuthStore.setState({
      status,
      profile: { userId, userName: email, email },
      contextMetadata: { userId, username: email },
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
  bucketIdentity: string | null,
  settings: ChatRunSettings,
): void {
  window.localStorage.setItem(
    composerRunSettingsKey(bucketIdentity),
    JSON.stringify({
      state: {
        globalLastRunSettings: settings,
        epicRunSettingsByEpicId: {},
      },
      version: 1,
    }),
  );
}

const HOST_ID = "host-a";
const EPIC_ID = "epic-1";

/**
 * A CURRENT-version (v2) blob, so the live per-host buckets are populated
 * rather than the migration-only legacy fallback that `persistSnapshot`
 * exercises. Account scoping has to hold for the fields that actually carry
 * settings today, not just the frozen v1 ones.
 */
function persistHostBucketSnapshot(
  bucketIdentity: string,
  hostId: string,
  settings: ChatRunSettings,
): void {
  window.localStorage.setItem(
    composerRunSettingsKey(bucketIdentity),
    JSON.stringify({
      state: {
        globalLastRunSettingsByHostId: { [hostId]: settings },
        epicRunSettingsByEpicHost: {
          [`${EPIC_ID} ${hostId}`]: { settings, updatedAt: 1 },
        },
        legacyGlobalLastRunSettings: null,
        legacyEpicRunSettingsByEpicId: {},
      },
      version: 2,
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

  it("adopts the legacy email-keyed bucket into the signed-in user's canonical bucket, once", async () => {
    // Seeds ONLY the legacy (email-keyed) bucket - nothing exists yet under
    // the canonical userId key - so a successful load here can only be
    // explained by the one-shot adoption path, not by scoping on the email.
    persistSnapshot(ALICE_EMAIL, ALICE_SETTINGS);
    resetAuth("signed-in", ALICE_EMAIL);

    render(
      <ComposerRunSettingsPersistLifecycleBridge>
        <div />
      </ComposerRunSettingsPersistLifecycleBridge>,
    );

    await waitFor(() => {
      expect(useComposerRunSettingsStore.persist.getOptions().name).toBe(
        composerRunSettingsKey(ALICE_ID),
      );
      expect(
        useComposerRunSettingsStore.getState().legacyGlobalLastRunSettings,
      ).toEqual(ALICE_SETTINGS);
    });
  });

  it("loads the second user's bucket without leaking first user state", async () => {
    persistSnapshot(ALICE_ID, ALICE_SETTINGS);
    persistSnapshot(BOB_ID, BOB_SETTINGS);

    render(
      <ComposerRunSettingsPersistLifecycleBridge>
        <div />
      </ComposerRunSettingsPersistLifecycleBridge>,
    );

    act(() => {
      resetAuth("signed-in", ALICE_EMAIL);
    });

    await waitFor(() => {
      expect(
        useComposerRunSettingsStore.getState().legacyGlobalLastRunSettings,
      ).toEqual(ALICE_SETTINGS);
    });

    act(() => {
      resetAuth("signed-in", BOB_EMAIL);
    });

    await waitFor(() => {
      expect(useComposerRunSettingsStore.persist.getOptions().name).toBe(
        composerRunSettingsKey(BOB_ID),
      );
      expect(
        useComposerRunSettingsStore.getState().legacyGlobalLastRunSettings,
      ).toEqual(BOB_SETTINGS);
    });
  });

  it("drops the previous account's per-host buckets when the next account has none", async () => {
    // Only Alice has a stored blob. Both accounts sign in on the SAME machine,
    // so `HOST_ID` is a key Bob's session would happily read - the account
    // scoping, not the host scoping, is what has to keep them apart.
    persistHostBucketSnapshot(ALICE_ID, HOST_ID, ALICE_SETTINGS);

    render(
      <ComposerRunSettingsPersistLifecycleBridge>
        <div />
      </ComposerRunSettingsPersistLifecycleBridge>,
    );

    act(() => {
      resetAuth("signed-in", ALICE_EMAIL);
    });

    await waitFor(() => {
      const state = useComposerRunSettingsStore.getState();
      expect(state.globalLastRunSettingsByHostId).toEqual({
        [HOST_ID]: ALICE_SETTINGS,
      });
      expect(state.getEpicRunSettings(EPIC_ID, HOST_ID)).toEqual(
        ALICE_SETTINGS,
      );
    });

    act(() => {
      resetAuth("signed-in", BOB_EMAIL);
    });

    await waitFor(() => {
      expect(useComposerRunSettingsStore.persist.getOptions().name).toBe(
        composerRunSettingsKey(BOB_ID),
      );
      const state = useComposerRunSettingsStore.getState();
      expect(state.globalLastRunSettingsByHostId).toEqual({});
      expect(state.epicRunSettingsByEpicHost).toEqual({});
      expect(state.getGlobalRunSettings(HOST_ID)).toBeNull();
      expect(state.getEpicRunSettings(EPIC_ID, HOST_ID)).toBeNull();
    });
  });

  it("signed-out clears the current bucket and resets to anonymous", async () => {
    persistSnapshot(ALICE_ID, ALICE_SETTINGS);
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
      resetAuth("signed-in", ALICE_EMAIL);
    });

    await waitFor(() => {
      expect(useComposerRunSettingsStore.persist.getOptions().name).toBe(
        composerRunSettingsKey(ALICE_ID),
      );
    });

    clearStorageSpy.mockClear();

    act(() => {
      resetAuth("signed-out", null);
    });

    await waitFor(() => {
      expect(clearStorageSpy).toHaveBeenCalledTimes(1);
      expect(
        window.localStorage.getItem(composerRunSettingsKey(ALICE_ID)),
      ).toBeNull();
      expect(useComposerRunSettingsStore.persist.getOptions().name).toBe(
        composerRunSettingsKey(null),
      );
      expect(
        useComposerRunSettingsStore.getState().legacyGlobalLastRunSettings,
      ).toBeNull();
    });

    clearStorageSpy.mockRestore();
  });
});
