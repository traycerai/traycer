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
 * The contract of `bindAuthInvalidation` against a scripted router: an auth
 * change invalidates at once when the router is idle, and otherwise waits for
 * the in-flight load to resolve, never starting a load under it. The real
 * router-core behavior behind that rule is pinned in
 * `router-auth-invalidation.integration.test.tsx`.
 */

interface FakeRouter {
  readonly router: AuthInvalidationRouter;
  readonly invalidate: Mock<() => Promise<void>>;
  readonly setStatus: (status: "pending" | "idle") => void;
  /** Emits `onResolved` the way the Transitioner does: status still pending. */
  readonly resolve: () => void;
  readonly listenerCount: () => number;
}

function makeFakeRouter(status: "pending" | "idle"): FakeRouter {
  const state: { status: "pending" | "idle" } = { status };
  const listeners = new Set<() => void>();
  const invalidate = vi.fn<() => Promise<void>>(() => Promise.resolve());
  const router: AuthInvalidationRouter = {
    state,
    invalidate,
    subscribe: (_eventType, fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
  return {
    router,
    invalidate,
    setStatus: (next) => {
      state.status = next;
    },
    resolve: () => {
      for (const listener of [...listeners]) listener();
      state.status = "idle";
    },
    listenerCount: () => listeners.size,
  };
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => {
    queueMicrotask(resolve);
  });
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
  // Status stays "signed-in"; only the active user changes.
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

  it("invalidates at once when the router is idle", () => {
    const { router, invalidate, listenerCount } = makeFakeRouter("idle");
    const unsubscribe = bindAuthInvalidation(router);

    signIn("user-a");

    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(listenerCount()).toBe(0);
    unsubscribe();
  });

  it("waits for an in-flight load to resolve, then invalidates once for every change that landed in it", async () => {
    const { router, invalidate, resolve, listenerCount } =
      makeFakeRouter("pending");
    const unsubscribe = bindAuthInvalidation(router);

    signIn("user-a");
    switchUser("user-b");

    expect(invalidate).not.toHaveBeenCalled();
    expect(listenerCount()).toBe(1);

    resolve();
    // Not inside the `onResolved` listener, where the router is still
    // pending: after it.
    expect(invalidate).not.toHaveBeenCalled();
    await flushMicrotasks();

    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(listenerCount()).toBe(0);
    unsubscribe();
  });

  it("waits again when another load is already in flight by the time the first resolves", async () => {
    const { router, invalidate, resolve, setStatus, listenerCount } =
      makeFakeRouter("pending");
    const unsubscribe = bindAuthInvalidation(router);

    signIn("user-a");
    resolve();
    // A navigation starts in the same commit.
    setStatus("pending");
    await flushMicrotasks();

    expect(invalidate).not.toHaveBeenCalled();
    expect(listenerCount()).toBe(1);

    resolve();
    await flushMicrotasks();

    expect(invalidate).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("does nothing when neither auth status nor userId changed", () => {
    const { router, invalidate, listenerCount } = makeFakeRouter("idle");
    const unsubscribe = bindAuthInvalidation(router);

    useAuthStore.setState({
      status: "signed-out",
      contextMetadata: null,
    });

    expect(invalidate).not.toHaveBeenCalled();
    expect(listenerCount()).toBe(0);
    unsubscribe();
  });

  it("stops reacting once unsubscribed, including a wait already armed", async () => {
    const { router, invalidate, resolve, listenerCount } =
      makeFakeRouter("pending");
    const unsubscribe = bindAuthInvalidation(router);

    signIn("user-a");
    unsubscribe();
    expect(listenerCount()).toBe(0);

    resolve();
    switchUser("user-b");
    await flushMicrotasks();

    expect(invalidate).not.toHaveBeenCalled();
  });
});
