import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { SurfaceHostSelectionPersistLifecycleBridge } from "@/providers/surface-host-selection-persist-lifecycle-bridge";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useSurfaceHostSelectionStore } from "@/stores/host/surface-host-selection-store";
import { surfaceHostSelectionKey } from "@/lib/persist";

/** Per-account persist is scoped by `userId`, not email: two accounts can share an address. Seed different userIds behind one email; sibling fixtures set `userId: email` and cannot see the gap. */

const SHARED_EMAIL = "shared@example.com";
const ALICE_USER_ID = "user-alice";
const BOB_USER_ID = "user-bob";

function signIn(userId: string, email: string): void {
  useAuthStore.setState({
    status: "signed-in",
    profile: { userId, userName: email, email },
    contextMetadata: { userId, username: email },
  });
}

function signOut(): void {
  useAuthStore.setState({
    status: "signed-out",
    profile: null,
    contextMetadata: null,
  });
}

function persistPins(key: string, tabId: string, hostId: string): void {
  window.localStorage.setItem(
    key,
    JSON.stringify({
      state: { pinsBySurface: { [tabId]: hostId } },
      version: 1,
    }),
  );
}

function renderBridge(): void {
  render(
    <SurfaceHostSelectionPersistLifecycleBridge>
      <div />
    </SurfaceHostSelectionPersistLifecycleBridge>,
  );
}

describe("persisted account scoping keys on the canonical user id", () => {
  beforeEach(() => {
    window.localStorage.clear();
    signOut();
    useSurfaceHostSelectionStore.persist.setOptions({
      name: surfaceHostSelectionKey(null),
    });
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    signOut();
  });

  it("gives two accounts sharing one email SEPARATE buckets", async () => {
    persistPins(surfaceHostSelectionKey(ALICE_USER_ID), "tab-1", "host-alice");
    persistPins(surfaceHostSelectionKey(BOB_USER_ID), "tab-1", "host-bob");

    signIn(ALICE_USER_ID, SHARED_EMAIL);
    renderBridge();
    await waitFor(() => {
      expect(useSurfaceHostSelectionStore.persist.getOptions().name).toBe(
        surfaceHostSelectionKey(ALICE_USER_ID),
      );
    });

    // The switch that the email comparison cannot see: same address, different
    // account. Keyed on email this fires no transition at all and the store
    // stays pointed at the previous account's bucket.
    signIn(BOB_USER_ID, SHARED_EMAIL);
    await waitFor(() => {
      expect(useSurfaceHostSelectionStore.persist.getOptions().name).toBe(
        surfaceHostSelectionKey(BOB_USER_ID),
      );
    });
    expect(useSurfaceHostSelectionStore.persist.getOptions().name).not.toBe(
      surfaceHostSelectionKey(SHARED_EMAIL),
    );
  });

  it("does NOT adopt an email-keyed bucket: this store never shipped keyed on the email", async () => {
    // surface-host-selection has no email-keyed predecessor. Adopting an email
    // blob would hand another account's pins to whoever signs in next.
    const emailKey = surfaceHostSelectionKey(SHARED_EMAIL);
    const nextKey = surfaceHostSelectionKey(ALICE_USER_ID);
    persistPins(emailKey, "tab-1", "host-not-mine");

    // Premise, positively: the canonical key does not exist yet, so a pin
    // that shows up under it below can only have come from adoption.
    expect(window.localStorage.getItem(nextKey)).toBeNull();

    signIn(ALICE_USER_ID, SHARED_EMAIL);
    renderBridge();

    await waitFor(() => {
      expect(useSurfaceHostSelectionStore.persist.getOptions().name).toBe(
        nextKey,
      );
    });
    expect(window.localStorage.getItem(nextKey) ?? "").not.toContain(
      "host-not-mine",
    );
    // And the email-keyed blob is left alone: not adopted, not retired.
    expect(window.localStorage.getItem(emailKey)).toContain("host-not-mine");
  });

  it("never lets the legacy bucket overwrite an account's own newer state", async () => {
    // After writing under the canonical key, a stale email blob must not
    // replace it on the next sign-in.
    const legacyKey = surfaceHostSelectionKey(SHARED_EMAIL);
    const nextKey = surfaceHostSelectionKey(ALICE_USER_ID);
    persistPins(legacyKey, "tab-1", "host-stale");
    persistPins(nextKey, "tab-1", "host-current");

    signIn(ALICE_USER_ID, SHARED_EMAIL);
    renderBridge();

    await waitFor(() => {
      expect(useSurfaceHostSelectionStore.persist.getOptions().name).toBe(
        nextKey,
      );
    });
    expect(window.localStorage.getItem(nextKey)).toContain("host-current");
  });
});
