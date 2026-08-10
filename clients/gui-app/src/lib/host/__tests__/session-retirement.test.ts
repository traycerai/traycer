import { describe, expect, it } from "vitest";
import { createSessionRetirementSweep } from "../session-retirement";

/**
 * The retirement trigger's predicate, pinned at its own seam. This predicate
 * has been wrong once already (a `current() === null` check that missed the
 * direct A -> B account switch), and its second draft (userId comparison)
 * missed A -> A' - so every transition class gets its own assertion here.
 *
 * The contract under test: the sweep keys on the context OBJECT REFERENCE. A
 * rotation mutates the current context in place (same reference, no sweep);
 * every genuine transition hands over a fresh object (sweep), including a
 * same-user re-sign-in that mints a fresh context.
 */

interface FakeContext {
  readonly userId: string;
}

function build(initial: FakeContext | null): {
  sweep: () => void;
  setContext: (next: FakeContext | null) => void;
  retireCalls: () => number;
} {
  let current = initial;
  let retires = 0;
  const sweep = createSessionRetirementSweep<FakeContext>({
    currentContext: () => current,
    retire: () => {
      retires += 1;
    },
  });
  return {
    sweep,
    setContext: (next) => {
      current = next;
    },
    retireCalls: () => retires,
  };
}

describe("createSessionRetirementSweep", () => {
  it("does not sweep while the context is unchanged - including repeated change events", () => {
    const contextA: FakeContext = { userId: "user-a" };
    const h = build(contextA);
    // Host-bound / availability / directory events all funnel through the
    // same onChange; none of them is an auth transition.
    h.sweep();
    h.sweep();
    h.sweep();
    expect(h.retireCalls()).toBe(0);
  });

  it("does not sweep on a same-user token refresh (rotation keeps the reference)", () => {
    const contextA: FakeContext = { userId: "user-a" };
    const h = build(contextA);
    // `rotateCurrentBearer` mutates the lease inside the SAME context object;
    // sweeping here would tear down every healthy shared connection on every
    // refresh.
    h.sweep();
    expect(h.retireCalls()).toBe(0);
  });

  it("sweeps on sign-out (A -> null)", () => {
    const contextA: FakeContext = { userId: "user-a" };
    const h = build(contextA);
    h.setContext(null);
    h.sweep();
    expect(h.retireCalls()).toBe(1);
  });

  it("sweeps on sign-in from signed-out (null -> A)", () => {
    const h = build(null);
    h.setContext({ userId: "user-a" });
    h.sweep();
    expect(h.retireCalls()).toBe(1);
  });

  it("sweeps on a DIRECT account switch (A -> B, no null intermediate)", () => {
    // A cross-window projection or credential-file reconcile replaces the
    // signed-in user in ONE transition - the counterexample that broke the
    // original `current() === null` predicate.
    const h = build({ userId: "user-a" });
    h.setContext({ userId: "user-b" });
    h.sweep();
    expect(h.retireCalls()).toBe(1);
  });

  it("sweeps on a same-user re-sign-in that minted a FRESH context (A -> A')", () => {
    // The transition a userId comparison cannot see: same user, new context
    // object, therefore a new credential lease and a new auth epoch - the old
    // epoch's sessions are exactly as retired as a signed-out user's. Today
    // `applySignedIn` usually rotates in place instead, but the provider
    // documents "auth-resigned-in" as legitimate; the sweep must not depend
    // on that other repair holding forever.
    const h = build({ userId: "user-a" });
    h.setContext({ userId: "user-a" });
    h.sweep();
    expect(h.retireCalls()).toBe(1);
  });

  it("sweeps once per transition, not once per change event after it", () => {
    const h = build({ userId: "user-a" });
    h.setContext({ userId: "user-b" });
    h.sweep();
    h.sweep();
    h.sweep();
    expect(h.retireCalls()).toBe(1);

    h.setContext(null);
    h.sweep();
    expect(h.retireCalls()).toBe(2);
  });

  it("a provider mounting under an already-signed-in user does not sweep that user's sessions", () => {
    // The initial context is captured at CREATION: the first change event
    // under the same context (e.g. the startup host-bound emit) must not
    // retire sessions the current user legitimately built.
    const contextA: FakeContext = { userId: "user-a" };
    const h = build(contextA);
    h.sweep();
    expect(h.retireCalls()).toBe(0);
  });
});
