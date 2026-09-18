import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `lease.ts` caches its window token in a module-level variable, set once on
 * first use. A fresh module graph per test is what makes "this window" vs
 * "another window" a controllable, deterministic distinction instead of a
 * leak between cases.
 */
async function freshLease(): Promise<{
  lease: typeof import("@/lib/customize/lease");
  store: typeof import("@/stores/customize/customize-store").useCustomizeStore;
}> {
  vi.resetModules();
  const lease = await import("@/lib/customize/lease");
  const { useCustomizeStore: store } =
    await import("@/stores/customize/customize-store");
  return { lease, store };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("customize lease: acquire", () => {
  it("acquires a free lease and locks nobody out locally", async () => {
    const { lease, store } = await freshLease();
    lease.initializeCustomizeWindow("me");

    const acquired = lease.acquireCustomizeLease();

    expect(acquired).toBe(true);
    expect(store.getState().lockedBy).toBe("none");
    expect(lease.readCustomizeLease()).toEqual({
      token: "me",
      expiresAt: 6000,
    });
  });

  it("fails to acquire while another window's lease is still live", async () => {
    const { lease, store } = await freshLease();
    lease.initializeCustomizeWindow("me");
    localStorage.setItem(
      lease.CUSTOMIZE_LEASE_KEY,
      JSON.stringify({ token: "other-window", expiresAt: 10_000 }),
    );

    const acquired = lease.acquireCustomizeLease();

    expect(acquired).toBe(false);
    expect(store.getState().lockedBy).toBe("other-window");
    // The other window's lease is untouched.
    expect(lease.readCustomizeLease()).toEqual({
      token: "other-window",
      expiresAt: 10_000,
    });
  });

  it("re-acquiring its own still-live lease succeeds (idempotent)", async () => {
    const { lease } = await freshLease();
    lease.initializeCustomizeWindow("me");
    lease.acquireCustomizeLease();

    expect(lease.acquireCustomizeLease()).toBe(true);
  });
});

describe("customize lease: expiry", () => {
  it("takes over a lease whose expiresAt is in the past", async () => {
    const { lease, store } = await freshLease();
    lease.initializeCustomizeWindow("me");
    localStorage.setItem(
      lease.CUSTOMIZE_LEASE_KEY,
      JSON.stringify({ token: "crashed-window", expiresAt: -1 }),
    );

    const acquired = lease.acquireCustomizeLease();

    expect(acquired).toBe(true);
    expect(store.getState().lockedBy).toBe("none");
    expect(lease.readCustomizeLease()).toEqual({
      token: "me",
      expiresAt: 6000,
    });
  });

  it("refreshCustomizeLock reports free once the held lease's time has passed", async () => {
    const { lease, store } = await freshLease();
    lease.initializeCustomizeWindow("me");
    localStorage.setItem(
      lease.CUSTOMIZE_LEASE_KEY,
      JSON.stringify({ token: "other-window", expiresAt: 5_000 }),
    );

    expect(lease.refreshCustomizeLock()).toBe(true);
    expect(store.getState().lockedBy).toBe("other-window");

    vi.setSystemTime(5_001);

    expect(lease.refreshCustomizeLock()).toBe(false);
    expect(store.getState().lockedBy).toBe("none");
  });

  it("ignores a malformed lease record instead of locking forever", async () => {
    const { lease } = await freshLease();
    localStorage.setItem(lease.CUSTOMIZE_LEASE_KEY, "{not json");

    expect(lease.readCustomizeLease()).toBeNull();
    expect(lease.refreshCustomizeLock()).toBe(false);
  });
});

describe("customize lease: release", () => {
  it("release clears its own lease and unlocks locally", async () => {
    const { lease, store } = await freshLease();
    lease.initializeCustomizeWindow("me");
    lease.acquireCustomizeLease();

    lease.releaseCustomizeLease();

    expect(lease.readCustomizeLease()).toBeNull();
    expect(store.getState().lockedBy).toBe("none");
  });

  it("release is a no-op on a lease another window currently holds", async () => {
    const { lease } = await freshLease();
    lease.initializeCustomizeWindow("me");
    localStorage.setItem(
      lease.CUSTOMIZE_LEASE_KEY,
      JSON.stringify({ token: "other-window", expiresAt: 10_000 }),
    );

    lease.releaseCustomizeLease();

    expect(lease.readCustomizeLease()).toEqual({
      token: "other-window",
      expiresAt: 10_000,
    });
  });
});
