/**
 * `IdentityTabsPersistLifecycleBridge` (Codex bot finding 38): the open
 * Identities tabs are bucketed by the signed-in account. Alice's records must
 * not reach Bob after she signs out and he signs in, and must come back when
 * she does - the same lifecycle the epic canvas half of the strip has.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { IdentityTabsPersistLifecycleBridge } from "@/providers/identity-tabs-persist-lifecycle-bridge";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  resetIdentityTabsStoreForTests,
  useIdentityTabsStore,
} from "@/stores/identities/identity-tabs-store";
import {
  __resetIdentityTabsHydrationForTests,
  isIdentityTabsHydrated,
} from "@/stores/identities/identity-tabs-hydration";
import { identityTabsKey } from "@/lib/persist";

const ALICE_EMAIL = "alice@example.com";
const BOB_EMAIL = "bob@example.com";
const ALICE_ID = `user:${ALICE_EMAIL}`;
const BOB_ID = `user:${BOB_EMAIL}`;

function resetAuth(
  status: "signed-out" | "signing-in" | "signed-in",
  email: string | null,
) {
  if (status === "signed-in" && email !== null) {
    const userId = `user:${email}`;
    useAuthStore.setState({
      status,
      profile: { userId, userName: email, email },
      contextMetadata: { userId, username: email },
    });
    return;
  }
  useAuthStore.setState({
    status,
    signedOutCause: "retired",
    profile: null,
    contextMetadata: null,
  });
}

/** The `signed-out` a FAILED interactive attempt lands on: credentials still on disk. */
function failAttempt(): void {
  useAuthStore.setState({
    status: "signed-out",
    signedOutCause: "attempt-failed",
    profile: null,
    contextMetadata: null,
  });
}

function resetIdentityTabsStore(): void {
  useIdentityTabsStore.persist.setOptions({ name: identityTabsKey(null) });
  resetIdentityTabsStoreForTests();
}

function renderBridge() {
  return render(
    <IdentityTabsPersistLifecycleBridge>
      <div />
    </IdentityTabsPersistLifecycleBridge>,
  );
}

describe("<IdentityTabsPersistLifecycleBridge />", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetAuth("signed-out", null);
    resetIdentityTabsStore();
    __resetIdentityTabsHydrationForTests();
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    resetAuth("signed-out", null);
    resetIdentityTabsStore();
  });

  it("keeps Alice's identity tabs from Bob, and restores them when Alice returns", async () => {
    renderBridge();

    act(() => {
      resetAuth("signed-in", ALICE_EMAIL);
    });
    await waitFor(() => {
      expect(useIdentityTabsStore.persist.getOptions().name).toBe(
        identityTabsKey(ALICE_ID),
      );
    });

    act(() => {
      useIdentityTabsStore.getState().openTab({
        identityId: "identity_alice",
        hostId: "host-a",
        title: "Alice's soul",
      });
    });
    // The write landed in ALICE's bucket, not the anonymous one.
    expect(window.localStorage.getItem(identityTabsKey(ALICE_ID))).toContain(
      "identity_alice",
    );
    expect(
      window.localStorage.getItem(identityTabsKey(null)) ?? "",
    ).not.toContain("identity_alice");

    act(() => {
      resetAuth("signed-out", null);
    });
    await waitFor(() => {
      expect(useIdentityTabsStore.persist.getOptions().name).toBe(
        identityTabsKey(null),
      );
    });
    // Sign-out wipes the outgoing account's bucket and empties the store.
    expect(useIdentityTabsStore.getState().openTabOrder).toEqual([]);
    expect(useIdentityTabsStore.getState().tabsById).toEqual({});

    act(() => {
      resetAuth("signed-in", BOB_EMAIL);
    });
    await waitFor(() => {
      expect(useIdentityTabsStore.persist.getOptions().name).toBe(
        identityTabsKey(BOB_ID),
      );
    });
    // Bob inherits nothing: no records, no order, nothing to activate.
    expect(useIdentityTabsStore.getState().tabsById).toEqual({});
    expect(useIdentityTabsStore.getState().openTabOrder).toEqual([]);
  });

  it("gives Alice her tabs back after Alice → sign-out → Bob → sign-out → Alice", async () => {
    // The ticket's line: "A back → A's restored". A sign-out DETACHES the
    // store from Alice's bucket; it must not delete it.
    renderBridge();

    act(() => {
      resetAuth("signed-in", ALICE_EMAIL);
    });
    await waitFor(() => {
      expect(useIdentityTabsStore.persist.getOptions().name).toBe(
        identityTabsKey(ALICE_ID),
      );
    });
    act(() => {
      useIdentityTabsStore.getState().openTab({
        identityId: "identity_alice",
        hostId: "host-a",
        title: "Alice's soul",
      });
    });

    act(() => {
      resetAuth("signed-out", null);
    });
    await waitFor(() => {
      expect(useIdentityTabsStore.persist.getOptions().name).toBe(
        identityTabsKey(null),
      );
    });
    expect(useIdentityTabsStore.getState().openTabOrder).toEqual([]);
    // Detached, not deleted.
    expect(window.localStorage.getItem(identityTabsKey(ALICE_ID))).toContain(
      "identity_alice",
    );

    act(() => {
      resetAuth("signed-in", BOB_EMAIL);
    });
    await waitFor(() => {
      expect(useIdentityTabsStore.persist.getOptions().name).toBe(
        identityTabsKey(BOB_ID),
      );
    });
    expect(useIdentityTabsStore.getState().openTabOrder).toEqual([]);
    act(() => {
      useIdentityTabsStore.getState().openTab({
        identityId: "identity_bob",
        hostId: "host-b",
        title: "Bob's soul",
      });
    });

    act(() => {
      resetAuth("signed-out", null);
    });
    await waitFor(() => {
      expect(useIdentityTabsStore.persist.getOptions().name).toBe(
        identityTabsKey(null),
      );
    });

    act(() => {
      resetAuth("signed-in", ALICE_EMAIL);
    });
    await waitFor(() => {
      expect(useIdentityTabsStore.getState().openTabOrder).toEqual([
        "identity_alice",
      ]);
    });
    expect(useIdentityTabsStore.getState().tabsById["identity_alice"]).toEqual({
      id: "identity_alice",
      identityId: "identity_alice",
      hostId: "host-a",
      title: "Alice's soul",
    });
    // And nothing of Bob's came along.
    expect(useIdentityTabsStore.getState().tabsById["identity_bob"]).toBe(
      undefined,
    );
  });

  it("marks the store hydrated for the account only once auth settles", async () => {
    resetAuth("signing-in", null);
    renderBridge();
    // A held attempt is not an answer: the anonymous bucket is not evidence
    // that the account has no tabs.
    expect(isIdentityTabsHydrated()).toBe(false);

    act(() => {
      resetAuth("signed-in", ALICE_EMAIL);
    });
    await waitFor(() => {
      expect(isIdentityTabsHydrated()).toBe(true);
    });
  });

  it("marks the store hydrated at once for an initially signed-out session", () => {
    renderBridge();
    expect(isIdentityTabsHydrated()).toBe(true);
  });

  it("keeps holding through a failed attempt and releases when recovery re-admits the account", async () => {
    // `applyInteractiveFailure` lands on `signed-out` with the credentials
    // file untouched; the auth classifier holds that edge and so must this
    // latch - the anonymous bucket is still not the account's answer.
    resetAuth("signing-in", null);
    renderBridge();
    expect(isIdentityTabsHydrated()).toBe(false);

    act(() => {
      failAttempt();
    });
    expect(isIdentityTabsHydrated()).toBe(false);

    act(() => {
      resetAuth("signed-in", ALICE_EMAIL);
    });
    await waitFor(() => {
      expect(isIdentityTabsHydrated()).toBe(true);
    });
    expect(useIdentityTabsStore.persist.getOptions().name).toBe(
      identityTabsKey(ALICE_ID),
    );
  });

  it("releases after a failed attempt once the identity is actually retired", () => {
    // `attempt-failed` -> `retired` keeps `status` at `signed-out` and moves
    // only the cause; the classifier reports nothing for it (there was no
    // identity to retire), so the latch has to observe the cause itself.
    resetAuth("signing-in", null);
    renderBridge();
    act(() => {
      failAttempt();
    });
    expect(isIdentityTabsHydrated()).toBe(false);

    act(() => {
      resetAuth("signed-out", null);
    });
    expect(isIdentityTabsHydrated()).toBe(true);
    expect(useIdentityTabsStore.persist.getOptions().name).toBe(
      identityTabsKey(null),
    );
  });

  it("restores an account's own bucket on sign-in and drops it for the next account", async () => {
    // Alice's bucket, persisted by an earlier session.
    window.localStorage.setItem(
      identityTabsKey(ALICE_ID),
      JSON.stringify({
        state: {
          tabsById: {
            identity_alice: {
              id: "identity_alice",
              identityId: "identity_alice",
              hostId: "host-a",
              title: "Alice's soul",
            },
          },
          openTabOrder: ["identity_alice"],
        },
        version: 1,
      }),
    );

    renderBridge();

    act(() => {
      resetAuth("signed-in", ALICE_EMAIL);
    });
    await waitFor(() => {
      expect(useIdentityTabsStore.getState().openTabOrder).toEqual([
        "identity_alice",
      ]);
    });
    expect(useIdentityTabsStore.getState().tabsById["identity_alice"]).toEqual({
      id: "identity_alice",
      identityId: "identity_alice",
      hostId: "host-a",
      title: "Alice's soul",
    });

    // Bob takes over the session without an intervening sign-out.
    act(() => {
      resetAuth("signed-in", BOB_EMAIL);
    });
    await waitFor(() => {
      expect(useIdentityTabsStore.persist.getOptions().name).toBe(
        identityTabsKey(BOB_ID),
      );
      expect(useIdentityTabsStore.getState().openTabOrder).toEqual([]);
    });
    expect(useIdentityTabsStore.getState().tabsById).toEqual({});
  });
});
