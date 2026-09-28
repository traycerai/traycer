import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `editor-lease.ts` caches its window token in a module-level variable, set
 * once on first use. A fresh module graph per test is what makes "this window"
 * vs "another window" a controllable, deterministic distinction instead of a
 * leak between cases.
 */
async function freshLease(): Promise<{
  lease: typeof import("@/lib/layout/editor-lease");
  store: typeof import("@/stores/layout/layout-editor-store").useLayoutEditorStore;
}> {
  vi.resetModules();
  const lease = await import("@/lib/layout/editor-lease");
  const { useLayoutEditorStore: store } =
    await import("@/stores/layout/layout-editor-store");
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

describe("layout editor lease: acquire", () => {
  it("acquires a free lease and locks nobody out locally", async () => {
    const { lease, store } = await freshLease();
    lease.initializeLayoutEditorWindow("me");

    const acquired = lease.acquireLayoutEditorLease();

    expect(acquired).toBe(true);
    expect(store.getState().lockedBy).toBe("none");
    expect(lease.readLayoutEditorLease()).toEqual({
      token: "me",
      expiresAt: 6000,
    });
  });

  it("fails to acquire while another window's lease is still live", async () => {
    const { lease, store } = await freshLease();
    lease.initializeLayoutEditorWindow("me");
    localStorage.setItem(
      lease.LAYOUT_EDITOR_LEASE_KEY,
      JSON.stringify({ token: "other-window", expiresAt: 10_000 }),
    );

    const acquired = lease.acquireLayoutEditorLease();

    expect(acquired).toBe(false);
    expect(store.getState().lockedBy).toBe("other-window");
    // The other window's lease is untouched.
    expect(lease.readLayoutEditorLease()).toEqual({
      token: "other-window",
      expiresAt: 10_000,
    });
  });

  it("re-acquiring its own still-live lease succeeds (idempotent)", async () => {
    const { lease } = await freshLease();
    lease.initializeLayoutEditorWindow("me");
    lease.acquireLayoutEditorLease();

    expect(lease.acquireLayoutEditorLease()).toBe(true);
  });
});

describe("layout editor lease: expiry", () => {
  it("takes over a lease whose expiresAt is in the past", async () => {
    const { lease, store } = await freshLease();
    lease.initializeLayoutEditorWindow("me");
    localStorage.setItem(
      lease.LAYOUT_EDITOR_LEASE_KEY,
      JSON.stringify({ token: "crashed-window", expiresAt: -1 }),
    );

    const acquired = lease.acquireLayoutEditorLease();

    expect(acquired).toBe(true);
    expect(store.getState().lockedBy).toBe("none");
    expect(lease.readLayoutEditorLease()).toEqual({
      token: "me",
      expiresAt: 6000,
    });
  });

  it("the watcher reports free on its own poll once the other window's lease has passed", async () => {
    const { lease, store } = await freshLease();
    lease.initializeLayoutEditorWindow("me");
    localStorage.setItem(
      lease.LAYOUT_EDITOR_LEASE_KEY,
      JSON.stringify({ token: "other-window", expiresAt: 5_000 }),
    );

    // Expiry emits no storage event, so only the 2s poll can notice it.
    const stop = lease.watchLayoutEditorLease(vi.fn());
    expect(store.getState().lockedBy).toBe("other-window");

    vi.advanceTimersByTime(4_000);
    expect(store.getState().lockedBy).toBe("other-window");

    vi.advanceTimersByTime(2_000);
    expect(store.getState().lockedBy).toBe("none");
    stop();
  });

  it("ignores a malformed lease record instead of locking forever", async () => {
    const { lease, store } = await freshLease();
    lease.initializeLayoutEditorWindow("me");
    localStorage.setItem(lease.LAYOUT_EDITOR_LEASE_KEY, "{not json");

    expect(lease.acquireLayoutEditorLease()).toBe(true);
    expect(store.getState().lockedBy).toBe("none");
  });
});

describe("layout editor lease: release", () => {
  it("release clears its own lease and unlocks locally", async () => {
    const { lease, store } = await freshLease();
    lease.initializeLayoutEditorWindow("me");
    lease.acquireLayoutEditorLease();

    lease.releaseLayoutEditorLease();

    expect(lease.readLayoutEditorLease()).toBeNull();
    expect(store.getState().lockedBy).toBe("none");
  });

  it("release is a no-op on a lease another window currently holds", async () => {
    const { lease } = await freshLease();
    lease.initializeLayoutEditorWindow("me");
    localStorage.setItem(
      lease.LAYOUT_EDITOR_LEASE_KEY,
      JSON.stringify({ token: "other-window", expiresAt: 10_000 }),
    );

    lease.releaseLayoutEditorLease();

    expect(lease.readLayoutEditorLease()).toEqual({
      token: "other-window",
      expiresAt: 10_000,
    });
  });
});
