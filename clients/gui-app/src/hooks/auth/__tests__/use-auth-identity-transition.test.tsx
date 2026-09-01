import { afterEach, describe, expect, it } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import {
  useAuthIdentityTransition,
  type AuthIdentityTransition,
} from "@/hooks/auth/use-auth-identity-transition";
import type { AuthStatus } from "@/stores/auth/auth-store";

afterEach(cleanup);

interface Props {
  readonly status: AuthStatus;
  readonly userId: string | null;
}

function setupTransitionProbe(initial: Props): {
  readonly transitions: AuthIdentityTransition[];
  readonly rerender: (props: Props) => void;
} {
  const transitions: AuthIdentityTransition[] = [];
  const { rerender } = renderHook(
    (props: Props) =>
      useAuthIdentityTransition(props.status, props.userId, (transition) => {
        transitions.push(transition);
      }),
    { initialProps: initial },
  );
  return { transitions, rerender };
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
    const { transitions, rerender } = setupTransitionProbe({
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
    rerender({ status: "signed-out", userId: null });
    expect(transitions).toEqual([]);

    // Recovery re-admits the same on-disk identity; still no transition.
    rerender({ status: "unverified", userId: "user-a" });
    expect(transitions).toEqual([]);
  });

  it("still emits signedOut for an explicit sign-out that never passes through signing-in", () => {
    const { transitions, rerender } = setupTransitionProbe({
      status: "signed-in",
      userId: "user-a",
    });
    expect(transitions).toEqual([
      { kind: "signedIn", userId: "user-a", isInitialMount: true },
    ]);
    transitions.length = 0;

    rerender({ status: "signed-out", userId: null });
    expect(transitions).toEqual([{ kind: "signedOut" }]);
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
