import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { bindAuthInvalidation, type AuthInvalidationRouter } from "@/router";
import { useAuthStore } from "@/stores/auth/auth-store";

/**
 * Regression coverage for the cold-launch initial-load race in
 * `bindAuthInvalidation`.
 *
 * The orphaning behavior was observed on @tanstack/react-router 1.170.25
 * (router-core 1.171.21, the lane-scheduler line, router-core >= 1.171.16):
 * calling `router.invalidate()` while the router's very first load is still
 * in flight (`status: "pending"` with `resolvedLocation: undefined` - no
 * match set has ever committed) retires that load inside router-core's
 * scheduler with nothing left to reschedule it - the app renders a
 * permanently blank screen. This repo currently pins 1.170.18 (router-core
 * 1.171.15), where an uncommitted-window invalidate was survivable. The
 * guard keeps the pattern safe on both: `bindAuthInvalidation` detects that
 * specific window and routes the auth change through `router.load()` first,
 * invalidating only once the load settles. Any other router state must
 * invalidate directly and must never call `load()`. These tests pin the
 * guard's contract independent of the installed version.
 *
 * The guard reads `resolvedLocation`, NOT the match array. router-core
 * publishes PROVISIONAL pending matches once a cold load outlives
 * `defaultPendingMs` (200ms) - well before anything commits - so a non-empty
 * `matches` array is not evidence of a commit. `resolvedLocation` is
 * assigned once the first load's render is acknowledged (after its match set
 * commits) and never cleared afterwards - `undefined` means no load has ever
 * fully resolved, which conservatively includes the just-committed-but-
 * unacknowledged instant. It is the only reliable "has this router ever
 * committed" signal. `AuthInvalidationRouter` does not expose `matches` at
 * all now, on purpose - the type itself makes the false signal impossible to
 * reach for.
 *
 * Recovery is COALESCED: `recovery` is closure state private to each
 * `bindAuthInvalidation` call (not module-scoped), so coalescing holds only
 * within a single binding's lifetime - it guarantees at most one `load()` +
 * one post-settle `invalidate()` per uncommitted window for that binding,
 * however many auth flips land inside it. `router.load()` on these
 * router-core versions ABORTS its predecessor transaction instead of joining
 * it, so issuing one `load()` per auth flip would multiply route passes.
 */

interface FakeRouter {
  readonly router: AuthInvalidationRouter;
  readonly load: Mock<() => Promise<void>>;
  readonly invalidate: Mock<() => Promise<void>>;
}

function makeFakeRouter(
  status: "pending" | "idle",
  resolvedLocation: unknown,
): FakeRouter {
  const load = vi.fn<() => Promise<void>>(() => Promise.resolve());
  const invalidate = vi.fn<() => Promise<void>>(() => Promise.resolve());
  const router: AuthInvalidationRouter = {
    state: { status, resolvedLocation },
    load,
    invalidate,
  };
  return { router, load, invalidate };
}

function resetAuthStore(): void {
  useAuthStore.setState({
    status: "signed-out",
    profile: null,
    contextMetadata: null,
    shareableTeams: [],
    subscriptionStatus: null,
  });
}

function signIn(userId: string): void {
  useAuthStore.setState({
    status: "signed-in",
    profile: { userId, userName: userId, email: `${userId}@example.com` },
    contextMetadata: { userId, username: userId },
  });
}

function switchUser(userId: string): void {
  // Status stays "signed-in"; only the active user changes (e.g. a device
  // switching the signed-in account). `bindAuthInvalidation` reacts to this
  // exactly like a status flip.
  useAuthStore.setState({
    contextMetadata: { userId, username: userId },
  });
}

describe("bindAuthInvalidation", () => {
  beforeEach(() => {
    resetAuthStore();
  });

  afterEach(() => {
    resetAuthStore();
  });

  it("routes through load() first when the router is mid initial-load (pending, resolvedLocation undefined), invalidating only after load resolves", async () => {
    const { router, load, invalidate } = makeFakeRouter("pending", undefined);
    let resolveLoad: () => void = () => {
      throw new Error("resolveLoad not assigned");
    };
    load.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveLoad = resolve;
        }),
    );
    const unsubscribe = bindAuthInvalidation(router);

    signIn("user-a");

    expect(load).toHaveBeenCalledTimes(1);
    // invalidate must not fire synchronously off the auth change - it is
    // gated behind the load promise settling.
    expect(invalidate).not.toHaveBeenCalled();

    resolveLoad();
    // Flush the microtask queue so the `.then(() => router.invalidate())`
    // continuation runs.
    await Promise.resolve();
    await Promise.resolve();

    expect(invalidate).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("takes the recovery path off resolvedLocation alone - extra state properties (e.g. provisional matches published past defaultPendingMs) do not matter", () => {
    // `AuthInvalidationRouter` no longer has a `matches` field, so this
    // widens the fake router's state past the narrowed interface (a real
    // router.state carries plenty else besides status/resolvedLocation) to
    // prove the guard genuinely ignores anything but resolvedLocation - it
    // is not silently keying off array-shaped fields it can no longer even
    // name.
    interface StateWithProvisionalMatches {
      status: "pending" | "idle";
      resolvedLocation: unknown;
      matches: ReadonlyArray<unknown>;
    }
    const stateWithProvisionalMatches: StateWithProvisionalMatches = {
      status: "pending",
      resolvedLocation: undefined,
      matches: [{ id: "provisional-match" }, { id: "another-provisional" }],
    };
    const load = vi.fn<() => Promise<void>>(() => Promise.resolve());
    const invalidate = vi.fn<() => Promise<void>>(() => Promise.resolve());
    const router: AuthInvalidationRouter = {
      state: stateWithProvisionalMatches,
      load,
      invalidate,
    };
    const unsubscribe = bindAuthInvalidation(router);

    signIn("user-a");

    expect(load).toHaveBeenCalledTimes(1);
    expect(invalidate).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("invalidates directly (no load()) when pending but resolvedLocation is already set (post-first-commit navigation)", () => {
    const { router, load, invalidate } = makeFakeRouter("pending", {
      href: "/epics/epic-a",
    });
    const unsubscribe = bindAuthInvalidation(router);

    signIn("user-a");

    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(load).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("invalidates directly (no load()) when idle with resolvedLocation set", () => {
    const { router, load, invalidate } = makeFakeRouter("idle", {
      href: "/",
    });
    const unsubscribe = bindAuthInvalidation(router);

    signIn("user-a");

    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(load).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("invalidates directly (no load()) when idle with resolvedLocation undefined - status must also be pending for the recovery guard", () => {
    // A never-loaded module-singleton router (e.g. before its first `load()`
    // call) can report idle/undefined. The guard is `pending &&
    // resolvedLocation === undefined`, not `resolvedLocation === undefined`
    // alone - "idle" means there is no in-flight load for invalidate() to
    // retire, so the direct path is safe here.
    const { router, load, invalidate } = makeFakeRouter("idle", undefined);
    const unsubscribe = bindAuthInvalidation(router);

    signIn("user-a");

    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(load).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("coalesces two auth flips inside the same uncommitted window into a single load() + a single post-settle invalidate()", async () => {
    const { router, load, invalidate } = makeFakeRouter("pending", undefined);
    const resolvers: Array<() => void> = [];
    load.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const unsubscribe = bindAuthInvalidation(router);

    // First flip: signed-out -> signed-in.
    signIn("user-a");
    // Second flip while the first recovery load is still unsettled: the
    // active user switches. Both land inside the same uncommitted window.
    switchUser("user-b");

    expect(load).toHaveBeenCalledTimes(1);
    expect(invalidate).not.toHaveBeenCalled();

    resolvers[0]();
    await Promise.resolve();
    await Promise.resolve();

    // Only one load() was ever issued, and only one invalidate() follows -
    // the second flip is covered by the first recovery's post-settle
    // invalidate, which re-runs route guards against the auth store's
    // latest snapshot rather than needing its own load()/invalidate() pair.
    expect(load).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("opens a fresh recovery slot for a later auth flip that lands after the previous recovery already settled", async () => {
    const { router, load, invalidate } = makeFakeRouter("pending", undefined);
    let resolveLoad: () => void = () => {
      throw new Error("resolveLoad not assigned");
    };
    load.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveLoad = resolve;
        }),
    );
    const unsubscribe = bindAuthInvalidation(router);

    signIn("user-a");
    expect(load).toHaveBeenCalledTimes(1);

    resolveLoad();
    await Promise.resolve();
    await Promise.resolve();
    expect(invalidate).toHaveBeenCalledTimes(1);

    // The router is still uncommitted (the fake router's state never
    // changes) when the next auth flip lands - the recovery slot must have
    // reset to null on settle so this opens a BRAND NEW recovery rather than
    // silently no-oping.
    switchUser("user-b");

    expect(load).toHaveBeenCalledTimes(2);
    expect(invalidate).toHaveBeenCalledTimes(1);

    resolveLoad();
    await Promise.resolve();
    await Promise.resolve();

    expect(invalidate).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("still invalidates exactly once when the recovery load() rejects, and consumes the rejection", async () => {
    const { router, load, invalidate } = makeFakeRouter("pending", undefined);
    let rejectLoad: (reason: Error) => void = () => {
      throw new Error("rejectLoad not assigned");
    };
    load.mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectLoad = reject;
        }),
    );
    const unsubscribe = bindAuthInvalidation(router);

    signIn("user-a");

    expect(load).toHaveBeenCalledTimes(1);
    // invalidate must not fire synchronously off the auth change - it is
    // gated behind the load promise settling, resolve or reject.
    expect(invalidate).not.toHaveBeenCalled();

    rejectLoad(new Error("initial load failed"));
    // Flush the microtask queue so the rejection handler passed as the
    // second `.then()` argument runs. If the rejection were left unhandled
    // (e.g. only a resolve handler was wired up), this would surface as an
    // unhandled rejection instead of driving `invalidate()`.
    await Promise.resolve();
    await Promise.resolve();

    expect(invalidate).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("does nothing when neither auth status nor userId changed", () => {
    const { router, load, invalidate } = makeFakeRouter("idle", {
      href: "/",
    });
    const unsubscribe = bindAuthInvalidation(router);

    // Re-assert the exact same status and contextMetadata (both already
    // null pre-existing values) - a no-op write from the store's point of
    // view.
    useAuthStore.setState({
      status: "signed-out",
      contextMetadata: null,
    });

    expect(invalidate).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("stops reacting to auth changes once unsubscribed", () => {
    const { router, load, invalidate } = makeFakeRouter("idle", {
      href: "/",
    });
    const unsubscribe = bindAuthInvalidation(router);

    unsubscribe();
    signIn("user-a");

    expect(invalidate).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  });
});
