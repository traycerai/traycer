import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import {
  useAuthIdentityTransition,
  type AuthIdentityTransition,
} from "@/hooks/auth/use-auth-identity-transition";
import {
  useAuthStore,
  type AuthStatus,
  type SignedOutCause,
} from "@/stores/auth/auth-store";

afterEach(() => {
  cleanup();
  useAuthStore.getState().setSignedOut();
});

interface Props {
  readonly status: AuthStatus;
  readonly userId: string | null;
}

function setupTransitionProbe(initial: Props): {
  readonly transitions: AuthIdentityTransition[];
  readonly rerender: (props: Props) => void;
  /**
   * Re-render at `signed-out` with the cause the service would have written
   * beside it: `attempt-failed` from `applyInteractiveFailure`, `retired` from
   * every other projection. The hook reads the cause from the store, so the
   * store is written first, as the reducers do.
   */
  readonly rerenderSignedOut: (cause: SignedOutCause) => void;
} {
  const transitions: AuthIdentityTransition[] = [];
  const { rerender } = renderHook(
    (props: Props) =>
      useAuthIdentityTransition(props.status, props.userId, (transition) => {
        transitions.push(transition);
      }),
    { initialProps: initial },
  );
  return {
    transitions,
    rerender,
    rerenderSignedOut: (cause) => {
      act(() => {
        if (cause === "attempt-failed") {
          useAuthStore.getState().setInteractiveAttemptFailed();
        } else {
          useAuthStore.getState().setSignedOut();
        }
      });
      rerender({ status: "signed-out", userId: null });
    },
  };
}

describe("useAuthIdentityTransition", () => {
  it("does not report an interactive sign-in that began on the first render as an initial mount", () => {
    // A hook that first renders in `signing-in` has its `previous` rewound to
    // `null` by the held-attempt branch. RED before the fix: the settled
    // `signed-in` then read `prior === null` and reported `isInitialMount:
    // true` for what is the documented `signing-in` -> `signed-in` edge.
    const { transitions, rerender } = setupTransitionProbe({
      status: "signing-in",
      userId: null,
    });
    expect(transitions).toEqual([]);

    rerender({ status: "signed-in", userId: "user-a" });
    expect(transitions).toEqual([
      { kind: "signedIn", userId: "user-a", isInitialMount: false },
    ]);
  });

  it("emits no transition for a failed interactive sign-in, nor for the recovery re-admit that follows it", () => {
    // Mount already `unverified` so the initial-mount `signedIn` fire (asserted
    // separately below) is out of the way before the sequence under test.
    const { transitions, rerender, rerenderSignedOut } = setupTransitionProbe({
      status: "unverified",
      userId: "user-a",
    });
    expect(transitions).toEqual([
      { kind: "signedIn", userId: "user-a", isInitialMount: true },
    ]);
    transitions.length = 0;

    rerender({ status: "signing-in", userId: "user-a" });
    expect(transitions).toEqual([]);

    // The regression: a failed interactive attempt used to fall through to
    // `signedOut` here because the dead `prior?.status === "signing-in"` clause
    // could never hold (the `signing-in` branch above already rewinds
    // `previous` past its own marker).
    rerenderSignedOut("attempt-failed");
    expect(transitions).toEqual([]);

    // Recovery re-admits the same on-disk identity; still no transition.
    rerender({ status: "unverified", userId: "user-a" });
    expect(transitions).toEqual([]);
  });

  it("still emits signedOut for an explicit sign-out that never passes through signing-in", () => {
    const { transitions, rerenderSignedOut } = setupTransitionProbe({
      status: "signed-in",
      userId: "user-a",
    });
    expect(transitions).toEqual([
      { kind: "signedIn", userId: "user-a", isInitialMount: true },
    ]);
    transitions.length = 0;

    rerenderSignedOut("retired");
    expect(transitions).toEqual([{ kind: "signedOut" }]);
  });

  it("emits signedOut for an explicit sign-out whose delete lands after a sign-in attempt began", () => {
    // `signOut()` awaits the credentials-file delete; the user starts a
    // sign-in during that wait, so the store goes `unverified` -> `signing-in`
    // -> `signed-out` - the failed-attempt sequence byte for byte. The file IS
    // gone here, and the service says so with `retired`. RED before the fix:
    // the held-attempt branch suppressed every `signed-out` reached while an
    // attempt was in flight, so no bridge purged the retired account's state.
    const { transitions, rerender, rerenderSignedOut } = setupTransitionProbe({
      status: "unverified",
      userId: "user-a",
    });
    transitions.length = 0;

    rerender({ status: "signing-in", userId: "user-a" });
    expect(transitions).toEqual([]);

    rerenderSignedOut("retired");
    expect(transitions).toEqual([{ kind: "signedOut" }]);

    // The attempt that outlived the sign-out may still succeed; that is a
    // fresh sign-in from nothing, not the re-admit a held failure gets.
    rerender({ status: "signed-in", userId: "user-a" });
    expect(transitions).toEqual([
      { kind: "signedOut" },
      { kind: "signedIn", userId: "user-a", isInitialMount: false },
    ]);
  });

  it("emits userSwitched when a different account lands from a held sign-in attempt", () => {
    const { transitions, rerender } = setupTransitionProbe({
      status: "unverified",
      userId: "user-a",
    });
    transitions.length = 0;

    rerender({ status: "signing-in", userId: "user-a" });
    expect(transitions).toEqual([]);

    rerender({ status: "signed-in", userId: "user-b" });
    expect(transitions).toEqual([{ kind: "userSwitched", userId: "user-b" }]);
  });

  it("emits signedIn with isInitialMount false for a sign-in reached through signing-in from signed-out", () => {
    const { transitions, rerender } = setupTransitionProbe({
      status: "signed-out",
      userId: null,
    });
    expect(transitions).toEqual([]);

    rerender({ status: "signing-in", userId: null });
    expect(transitions).toEqual([]);

    rerender({ status: "signed-in", userId: "user-a" });
    expect(transitions).toEqual([
      { kind: "signedIn", userId: "user-a", isInitialMount: false },
    ]);
  });

  it("emits signedIn with isInitialMount true on the very first render at signed-in", () => {
    const { transitions } = setupTransitionProbe({
      status: "signed-in",
      userId: "user-a",
    });
    expect(transitions).toEqual([
      { kind: "signedIn", userId: "user-a", isInitialMount: true },
    ]);
  });
});
