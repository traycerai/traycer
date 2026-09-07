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

/** Cold-launch race: `router.invalidate()` while the first load is still pending (`resolvedLocation` undefined) orphans the load. Guard with `resolvedLocation`, not the match array. Any other router state must invalidate directly and never call `load()`. */

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
    // Widen fake state past the narrowed interface so the guard cannot be
    // silently keying off matches or other array-shaped fields.
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
    // Guard is pending && resolvedLocation === undefined. Idle with undefined
    // has no in-flight load; the direct path is safe.
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

    // One load, one invalidate. A second flip is covered by the first
    // recovery's post-settle invalidate.
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

    // Recovery slot must reset to null on settle so the next flip opens a
    // new recovery.
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
    // Flush microtasks so the rejection handler runs. An unhandled rejection
    // would not drive invalidate().
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
