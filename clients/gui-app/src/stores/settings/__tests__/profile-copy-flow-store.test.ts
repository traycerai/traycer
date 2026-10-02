import { afterEach, describe, expect, it } from "vitest";
import {
  ATTEMPT_ID,
  ATTEMPT_TWO_ID,
  DEST_HOST_ID,
  DEST_HOST_TWO_ID,
  SOURCE_HOST_ID,
  SOURCE_PROFILE_ID,
  profileCopyAttempt,
} from "@/lib/profile-copy/__tests__/profile-copy-test-fixtures";
import { useProfileCopyFlowStore } from "@/stores/settings/profile-copy-flow-store";

function resetFlowStore(): void {
  useProfileCopyFlowStore.setState({
    view: null,
    session: 0,
    activeLogin: null,
    directBlocks: {},
  });
}

describe("useProfileCopyFlowStore", () => {
  afterEach(resetFlowStore);

  it("bumps session on every open so the same view remounts", () => {
    const view = {
      kind: "new" as const,
      sourceHostId: SOURCE_HOST_ID,
      providerId: "claude" as const,
      sourceProfileId: SOURCE_PROFILE_ID,
    };
    useProfileCopyFlowStore.getState().open(view);
    expect(useProfileCopyFlowStore.getState().session).toBe(1);
    useProfileCopyFlowStore.getState().open(view);
    expect(useProfileCopyFlowStore.getState().session).toBe(2);
    expect(useProfileCopyFlowStore.getState().view).toEqual(view);
  });

  it("claimLogin refuses a second attempt and releaseLogin only clears the holder", () => {
    const first = {
      destinationHostId: DEST_HOST_ID,
      attemptId: ATTEMPT_ID,
    };
    const second = {
      destinationHostId: DEST_HOST_TWO_ID,
      attemptId: ATTEMPT_TWO_ID,
    };
    expect(useProfileCopyFlowStore.getState().claimLogin(first)).toBe(true);
    expect(useProfileCopyFlowStore.getState().claimLogin(second)).toBe(false);
    expect(useProfileCopyFlowStore.getState().activeLogin).toEqual(first);

    useProfileCopyFlowStore.getState().releaseLogin(ATTEMPT_TWO_ID);
    expect(useProfileCopyFlowStore.getState().activeLogin).toEqual(first);

    useProfileCopyFlowStore.getState().releaseLogin(ATTEMPT_ID);
    expect(useProfileCopyFlowStore.getState().activeLogin).toBeNull();
  });

  it("allows the holder to re-claim the same attempt", () => {
    const login = {
      destinationHostId: DEST_HOST_ID,
      attemptId: ATTEMPT_ID,
    };
    expect(useProfileCopyFlowStore.getState().claimLogin(login)).toBe(true);
    expect(useProfileCopyFlowStore.getState().claimLogin(login)).toBe(true);
  });

  it("counts repeats only for the same verb and reason, whatever the revision", () => {
    const store = useProfileCopyFlowStore.getState();
    store.recordDirectBlock(ATTEMPT_ID, {
      verb: "sign-in",
      revision: 3,
      reason: "login-start-unavailable",
    });
    expect(useProfileCopyFlowStore.getState().directBlocks[ATTEMPT_ID]).toEqual(
      {
        verb: "sign-in",
        revision: 3,
        reason: "login-start-unavailable",
        repeats: 1,
      },
    );
    store.recordDirectBlock(ATTEMPT_ID, {
      verb: "sign-in",
      revision: 4,
      reason: "login-start-unavailable",
    });
    expect(
      useProfileCopyFlowStore.getState().directBlocks[ATTEMPT_ID]?.repeats,
    ).toBe(2);
    store.recordDirectBlock(ATTEMPT_ID, {
      verb: "sign-in",
      revision: 5,
      reason: "login-resource-busy",
    });
    expect(useProfileCopyFlowStore.getState().directBlocks[ATTEMPT_ID]).toEqual(
      {
        verb: "sign-in",
        revision: 5,
        reason: "login-resource-busy",
        repeats: 1,
      },
    );
    store.recordDirectBlock(ATTEMPT_ID, {
      verb: "verify",
      revision: 5,
      reason: "login-resource-busy",
    });
    expect(useProfileCopyFlowStore.getState().directBlocks[ATTEMPT_ID]).toEqual(
      {
        verb: "verify",
        revision: 5,
        reason: "login-resource-busy",
        repeats: 1,
      },
    );
  });

  it("clears a direct block only when the stored verb matches", () => {
    const store = useProfileCopyFlowStore.getState();
    store.recordDirectBlock(ATTEMPT_ID, {
      verb: "verify",
      revision: 2,
      reason: "unsupported-auth",
    });
    store.clearDirectBlock(ATTEMPT_ID, "sign-in");
    expect(
      useProfileCopyFlowStore.getState().directBlocks[ATTEMPT_ID]?.verb,
    ).toBe("verify");
    store.clearDirectBlock(ATTEMPT_ID, "verify");
    expect(
      useProfileCopyFlowStore.getState().directBlocks[ATTEMPT_ID],
    ).toBeUndefined();
  });

  it("reset clears view, login and blocks and leaves session alone", () => {
    const view = {
      kind: "draft" as const,
      destinationHostId: DEST_HOST_ID,
      attempt: profileCopyAttempt({}),
      profileName: "Work",
    };
    useProfileCopyFlowStore.getState().open(view);
    useProfileCopyFlowStore.getState().claimLogin({
      destinationHostId: DEST_HOST_ID,
      attemptId: ATTEMPT_ID,
    });
    useProfileCopyFlowStore.getState().recordDirectBlock(ATTEMPT_ID, {
      verb: "sign-in",
      revision: 1,
      reason: "adapter-not-admitted",
    });
    const session = useProfileCopyFlowStore.getState().session;
    expect(session).toBeGreaterThan(0);
    useProfileCopyFlowStore.getState().reset();
    expect(useProfileCopyFlowStore.getState().view).toBeNull();
    expect(useProfileCopyFlowStore.getState().activeLogin).toBeNull();
    expect(useProfileCopyFlowStore.getState().directBlocks).toEqual({});
    expect(useProfileCopyFlowStore.getState().session).toBe(session);
  });
});
