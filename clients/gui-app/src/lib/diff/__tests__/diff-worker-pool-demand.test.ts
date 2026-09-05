import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkerPoolManager } from "@pierre/diffs/worker";
import {
  __resetDiffWorkerPoolForTests,
  getDiffWorkerPool,
  getDiffWorkerPoolAvailability,
  registerDiffWorkerPoolCreator,
  requestDiffWorkerPool,
  subscribeDiffWorkerPool,
  unregisterDiffWorkerPoolCreator,
} from "@/lib/diff/diff-worker-pool-demand";

interface FakeWorkerPoolManager {
  readonly setRenderOptions: () => Promise<void>;
  readonly primeFileHighlightCache: () => Promise<void>;
  readonly primeDiffHighlightCache: () => Promise<void>;
}

/**
 * A prototype-less object asserted to the class type, with the three members
 * a consumer could call assigned onto it (`as unknown as` is lint-forbidden
 * here, and a three-member literal does not overlap the ~90-member class
 * enough for a direct `as`). Each fake is its own object identity, which is
 * all these tests read - none of the three methods is ever called.
 */
function fakeManager(id: string): WorkerPoolManager {
  const fake: FakeWorkerPoolManager & { readonly debugId: string } = {
    debugId: id,
    setRenderOptions: () => Promise.resolve(),
    primeFileHighlightCache: () => Promise.resolve(),
    primeDiffHighlightCache: () => Promise.resolve(),
  };
  return Object.assign(Object.create(null) as WorkerPoolManager, fake);
}

function fakeCreator(id: string): () => WorkerPoolManager {
  return () => fakeManager(id);
}

describe("diff-worker-pool-demand", () => {
  beforeEach(() => {
    __resetDiffWorkerPoolForTests();
  });

  afterEach(() => {
    __resetDiffWorkerPoolForTests();
  });

  it("starts pending: no manager, no creator, not requested", () => {
    expect(getDiffWorkerPool()).toBeUndefined();
    expect(getDiffWorkerPoolAvailability()).toBe("pending");
  });

  it("creates the pool exactly once when requested, then registered", () => {
    const creator = vi.fn(fakeCreator("a"));
    requestDiffWorkerPool();
    // No creator registered yet: a request alone cannot create the pool.
    expect(getDiffWorkerPoolAvailability()).toBe("unavailable");
    expect(getDiffWorkerPool()).toBeUndefined();

    registerDiffWorkerPoolCreator(creator);

    expect(creator).toHaveBeenCalledTimes(1);
    expect(getDiffWorkerPoolAvailability()).toBe("ready");
    expect(getDiffWorkerPool()).toBe(creator.mock.results[0]?.value);
  });

  it("creates the pool exactly once when registered, then requested", () => {
    const creator = vi.fn(fakeCreator("b"));
    registerDiffWorkerPoolCreator(creator);
    expect(creator).not.toHaveBeenCalled();
    expect(getDiffWorkerPoolAvailability()).toBe("pending");

    requestDiffWorkerPool();

    expect(creator).toHaveBeenCalledTimes(1);
    expect(getDiffWorkerPoolAvailability()).toBe("ready");
    expect(getDiffWorkerPool()).toBe(creator.mock.results[0]?.value);
  });

  it("never calls the creator a second time for a repeated request or a re-registration", () => {
    const creator = vi.fn(fakeCreator("c"));
    registerDiffWorkerPoolCreator(creator);
    requestDiffWorkerPool();
    expect(creator).toHaveBeenCalledTimes(1);

    requestDiffWorkerPool();
    registerDiffWorkerPoolCreator(creator);

    expect(creator).toHaveBeenCalledTimes(1);
  });

  it("reports 'unavailable' once requested with no creator registered", () => {
    expect(getDiffWorkerPoolAvailability()).toBe("pending");
    requestDiffWorkerPool();
    expect(getDiffWorkerPoolAvailability()).toBe("unavailable");
    expect(getDiffWorkerPool()).toBeUndefined();
  });

  it("moves from 'unavailable' to 'ready' once a creator registers after the request", () => {
    requestDiffWorkerPool();
    expect(getDiffWorkerPoolAvailability()).toBe("unavailable");

    registerDiffWorkerPoolCreator(fakeCreator("d"));

    expect(getDiffWorkerPoolAvailability()).toBe("ready");
    expect(getDiffWorkerPool()).toBeDefined();
  });

  it("moves from 'pending' to 'ready' once the pool is created", () => {
    registerDiffWorkerPoolCreator(fakeCreator("e"));
    expect(getDiffWorkerPoolAvailability()).toBe("pending");

    requestDiffWorkerPool();

    expect(getDiffWorkerPoolAvailability()).toBe("ready");
  });

  it("notifies subscribers on register, request, and unregister", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeDiffWorkerPool(listener);
    const creator = fakeCreator("f");

    registerDiffWorkerPoolCreator(creator);
    expect(listener).toHaveBeenCalledTimes(1);

    requestDiffWorkerPool();
    // The request both creates the pool (one notify from createIfDue) and
    // notifies again for the request itself.
    expect(listener.mock.calls.length).toBeGreaterThanOrEqual(2);

    listener.mockClear();
    unregisterDiffWorkerPoolCreator(creator);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
  });

  it("stops notifying a listener once it has unsubscribed", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeDiffWorkerPool(listener);
    unsubscribe();

    registerDiffWorkerPoolCreator(fakeCreator("g"));
    requestDiffWorkerPool();

    expect(listener).not.toHaveBeenCalled();
  });

  it("treats unregistering a different creator than the one registered as a no-op", () => {
    const registered = fakeCreator("h");
    const other = fakeCreator("not-registered");
    registerDiffWorkerPoolCreator(registered);
    requestDiffWorkerPool();
    const manager = getDiffWorkerPool();
    expect(manager).toBeDefined();

    unregisterDiffWorkerPoolCreator(other);

    // The real creator (and the manager it built) survive an unregister call
    // naming a different creator function.
    expect(getDiffWorkerPool()).toBe(manager);
    expect(getDiffWorkerPoolAvailability()).toBe("ready");
  });

  it("clears the manager, creator, AND the request when the registered creator unregisters", () => {
    const creator = fakeCreator("i");
    registerDiffWorkerPoolCreator(creator);
    requestDiffWorkerPool();
    expect(getDiffWorkerPool()).toBeDefined();

    unregisterDiffWorkerPoolCreator(creator);

    expect(getDiffWorkerPool()).toBeUndefined();
    // The request is cleared too, not just the creator/manager: every surface
    // that could have asked for a pool renders below the provider, so it has
    // unmounted along with it, and a `requested` left standing would make the
    // NEXT registration build a pool eagerly during its own mount.
    expect(getDiffWorkerPoolAvailability()).toBe("pending");
  });

  it("does not eagerly rebuild a pool for a second app-shell lifetime's registration after unregister", () => {
    // The regression this pins: a host outage or sign-out unmounts the
    // provider and remounts it under `HostReadyGate` within one session. The
    // second lifetime must be exactly as lazy as the first - nothing has
    // asked for a pool YET in this lifetime, so registering its creator alone
    // must not build one.
    const creator1 = vi.fn(fakeCreator("k1"));
    registerDiffWorkerPoolCreator(creator1);
    requestDiffWorkerPool();
    expect(creator1).toHaveBeenCalledTimes(1);
    expect(getDiffWorkerPool()).toBeDefined();

    unregisterDiffWorkerPoolCreator(creator1);

    // Second lifetime: the provider re-registers with a fresh creator.
    const creator2 = vi.fn(fakeCreator("k2"));
    registerDiffWorkerPoolCreator(creator2);

    expect(creator2).not.toHaveBeenCalled();
    expect(getDiffWorkerPool()).toBeUndefined();
    expect(getDiffWorkerPoolAvailability()).toBe("pending");

    // Only a fresh request, made in THIS lifetime, re-creates the pool.
    requestDiffWorkerPool();

    expect(creator2).toHaveBeenCalledTimes(1);
    expect(getDiffWorkerPool()).toBe(creator2.mock.results[0]?.value);
    expect(getDiffWorkerPoolAvailability()).toBe("ready");
  });

  it("getDiffWorkerPool() reflects exactly the manager the creator produced", () => {
    const manager = fakeManager("j");
    registerDiffWorkerPoolCreator(() => manager);
    requestDiffWorkerPool();

    expect(getDiffWorkerPool()).toBe(manager);
  });
});
