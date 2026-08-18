import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { SurfaceHostSelectionPersistLifecycleBridge } from "@/providers/surface-host-selection-persist-lifecycle-bridge";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useSurfaceHostSelectionStore } from "@/stores/host/surface-host-selection-store";
import { gitDiffPanelSurfaceKey } from "@/stores/host/surface-host-selection-store";
import { surfaceHostSelectionKey } from "@/lib/persist";

const GIT_KEY = gitDiffPanelSurfaceKey("tab-1");

const ALICE_EMAIL = "a@b.com";
const BOB_EMAIL = "b@b.com";
// userId and email deliberately DIFFER: a fixture that equates them cannot
// detect email-keyed scoping. Unlike the other bridges, this store was ADDED
// in this release (TASK 2) - there is no legacy email-keyed predecessor, so
// no arm here seeds under the raw email key.
const ALICE_ID = `user:${ALICE_EMAIL}`;
const BOB_ID = `user:${BOB_EMAIL}`;

function resetAuth(
  status: "signed-out" | "signing-in" | "signed-in",
  email: string | null,
): void {
  if (status === "signed-in" && email !== null) {
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

function resetStore(): void {
  useSurfaceHostSelectionStore.persist.setOptions({
    name: surfaceHostSelectionKey(null),
  });
  useSurfaceHostSelectionStore.getState().resetForTests();
}

function persistSnapshot(bucketIdentity: string | null, hostId: string): void {
  window.localStorage.setItem(
    surfaceHostSelectionKey(bucketIdentity),
    JSON.stringify({
      state: { selections: { [GIT_KEY]: hostId } },
      version: 1,
    }),
  );
}

describe("<SurfaceHostSelectionPersistLifecycleBridge />", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetAuth("signed-out", null);
    resetStore();
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    resetAuth("signed-out", null);
    resetStore();
  });

  it("retargets to the signed-in user's surface-pin bucket", async () => {
    persistSnapshot(ALICE_ID, "host-alice");

    render(
      <SurfaceHostSelectionPersistLifecycleBridge>
        <div />
      </SurfaceHostSelectionPersistLifecycleBridge>,
    );

    act(() => {
      resetAuth("signed-in", ALICE_EMAIL);
    });

    await waitFor(() => {
      expect(useSurfaceHostSelectionStore.getState().selections[GIT_KEY]).toBe(
        "host-alice",
      );
    });
  });

  it("wipes pins on sign-out", async () => {
    persistSnapshot(ALICE_ID, "host-alice");
    render(
      <SurfaceHostSelectionPersistLifecycleBridge>
        <div />
      </SurfaceHostSelectionPersistLifecycleBridge>,
    );
    act(() => {
      resetAuth("signed-in", ALICE_EMAIL);
    });
    await waitFor(() => {
      expect(useSurfaceHostSelectionStore.getState().selections[GIT_KEY]).toBe(
        "host-alice",
      );
    });

    act(() => {
      resetAuth("signed-out", null);
    });

    await waitFor(() => {
      expect(useSurfaceHostSelectionStore.getState().selections).toEqual({});
    });
    expect(window.localStorage.getItem(surfaceHostSelectionKey(ALICE_ID))).toBe(
      null,
    );
  });

  it("retargets the persist bucket on user switch", async () => {
    persistSnapshot(ALICE_ID, "host-alice");
    persistSnapshot(BOB_ID, "host-bob");

    render(
      <SurfaceHostSelectionPersistLifecycleBridge>
        <div />
      </SurfaceHostSelectionPersistLifecycleBridge>,
    );

    act(() => {
      resetAuth("signed-in", ALICE_EMAIL);
    });
    await waitFor(() => {
      expect(useSurfaceHostSelectionStore.getState().selections[GIT_KEY]).toBe(
        "host-alice",
      );
    });

    act(() => {
      resetAuth("signed-in", BOB_EMAIL);
    });
    await waitFor(() => {
      expect(useSurfaceHostSelectionStore.getState().selections[GIT_KEY]).toBe(
        "host-bob",
      );
    });
  });
});
