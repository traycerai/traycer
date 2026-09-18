import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { ProfileCopyOperationsPersistLifecycleBridge } from "@/providers/profile-copy-operations-persist-lifecycle-bridge";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  useProfileCopyOperationsStore,
  type ProfileCopyOperationHandle,
} from "@/stores/settings/profile-copy-operations-store";
import { profileCopyOperationsKey } from "@/lib/persist";
import {
  previewRecord,
  SOURCE_HOST_ID,
  SOURCE_PROFILE_ID,
} from "@/lib/profile-copy/__tests__/profile-copy-test-fixtures";

const ALICE = "user-alice";
const BOB = "user-bob";
const EMAIL = "shared@example.com";

function signIn(userId: string): void {
  useAuthStore.setState({
    status: "signed-in",
    profile: { userId, userName: EMAIL, email: EMAIL },
    contextMetadata: { userId, username: EMAIL },
  });
}

function signOut(): void {
  useAuthStore.setState({
    status: "signed-out",
    profile: null,
    contextMetadata: null,
  });
}

function flushPersist(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function sampleHandle(): ProfileCopyOperationHandle {
  return {
    operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    sourceHostId: SOURCE_HOST_ID,
    sourceProfileId: SOURCE_PROFILE_ID,
    providerId: "claude",
    destinationHostIds: ["dest-host"],
    previewRevision: "a".repeat(64),
    previewRecords: [previewRecord({})],
    createdAt: 1_000,
    startAcknowledged: true,
    cancelConfirmedAt: null,
  };
}

describe("ProfileCopyOperationsPersistLifecycleBridge", () => {
  beforeEach(async () => {
    window.localStorage.clear();
    signOut();
    useProfileCopyOperationsStore.persist.setOptions({
      name: profileCopyOperationsKey(null),
    });
    await useProfileCopyOperationsStore.persist.rehydrate();
    useProfileCopyOperationsStore.setState({ handles: [] });
  });

  afterEach(async () => {
    cleanup();
    window.localStorage.clear();
    signOut();
    useProfileCopyOperationsStore.persist.setOptions({
      name: profileCopyOperationsKey(null),
    });
    await useProfileCopyOperationsStore.persist.rehydrate();
    useProfileCopyOperationsStore.setState({ handles: [] });
  });

  it("scopes handles by account and clears them on sign-out", async () => {
    signIn(ALICE);
    render(<ProfileCopyOperationsPersistLifecycleBridge />);
    await waitFor(() =>
      expect(useProfileCopyOperationsStore.persist.getOptions().name).toBe(
        profileCopyOperationsKey(ALICE),
      ),
    );
    useProfileCopyOperationsStore.getState().record(sampleHandle());
    await flushPersist();
    expect(useProfileCopyOperationsStore.getState().handles).toHaveLength(1);

    signIn(BOB);
    await waitFor(() =>
      expect(useProfileCopyOperationsStore.persist.getOptions().name).toBe(
        profileCopyOperationsKey(BOB),
      ),
    );
    expect(useProfileCopyOperationsStore.getState().handles).toEqual([]);

    signIn(ALICE);
    await waitFor(() =>
      expect(useProfileCopyOperationsStore.persist.getOptions().name).toBe(
        profileCopyOperationsKey(ALICE),
      ),
    );
    expect(
      useProfileCopyOperationsStore
        .getState()
        .handles.map((handle) => handle.operationId),
    ).toEqual(["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]);

    signOut();
    await waitFor(() =>
      expect(useProfileCopyOperationsStore.persist.getOptions().name).toBe(
        profileCopyOperationsKey(null),
      ),
    );
    expect(useProfileCopyOperationsStore.getState().handles).toEqual([]);
  });
});
