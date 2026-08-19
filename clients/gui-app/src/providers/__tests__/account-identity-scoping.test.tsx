import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { SurfaceHostSelectionPersistLifecycleBridge } from "@/providers/surface-host-selection-persist-lifecycle-bridge";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useSurfaceHostSelectionStore } from "@/stores/host/surface-host-selection-store";
import { surfaceHostSelectionKey } from "@/lib/persist";

/**
 * Codex #1243 T-60, and the nine sibling bridges the invariant census found
 * alongside it.
 *
 * Persisted per-account state is scoped by the identity
 * `useAuthIdentityTransition` watches. That identity used to be the EMAIL,
 * which reads like an identity and is not one: two canonical accounts can
 * present the same address. For that pair `prior !== next` is false, so no
 * `userSwitched` fires, no store is retargeted or reset, and the incoming
 * account inherits the outgoing account's state - here, host pins, which are
 * account-scoped ids naming machines the new fleet has never contained.
 *
 * WHY THE EXISTING BRIDGE TESTS COULD NOT CATCH THIS: every one of them seeds
 * auth with `userId: email` (see the sibling files in this directory), so the
 * two values are the same string and no assertion can tell which one the code
 * read. The defect lives precisely in the gap between them, so an arm that
 * closes the gap is the only kind that can fail. This file therefore seeds
 * DIFFERENT userIds behind ONE email, which is the real-world shape and the
 * one no existing fixture produces.
 */

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
    // Unlike the composer / worktree / canvas bridges (whose suites carry the
    // adopt-and-retire arm), surface-host-selection was ADDED in this release
    // and has no email-keyed predecessor on any install. A blob under the
    // email key is therefore not this account's state - it is whatever some
    // other writer left there - and adopting it would be a mechanism with no
    // producer that hands one account's pins to whichever account signs in
    // next under the same address.
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
    // The control for the adoption above. Once an account has written under
    // its canonical key, a stale email-keyed blob must not be able to come
    // back and replace it - which is what an unguarded adopt would do on every
    // sign-in.
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
