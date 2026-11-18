import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostRemovalState } from "../../../ipc-contracts/host-management-types";

/**
 * **The initial load must never overwrite a completed mutation** (the
 * remove-vs-preflight cache race).
 *
 * `isHostRemovedByUser()` lazily loads the sentinel from disk on first call.
 * That load is async, and `markHostRemovedByUser()` /
 * `clearHostRemovedByUser()` can start AND fully complete while it is still
 * in flight - `removeTraycer` and the launch-time converge preflight run
 * concurrently by design, so this is a real interleaving, not a theoretical
 * one. The load's result is then a PRE-mutation snapshot of the file; caching
 * it unconditionally overwrites the value the mutation just confirmed to
 * disk, and every subsequent gate (`convergeReady`, `respawn`,
 * `recoverIfDown`, `applyStaged`) reads the stale answer from cache until the
 * process restarts. For `mark` that means the app can silently reinstall the
 * host the user just removed - exactly what the sentinel exists to prevent.
 *
 * The store is faked HERE (unlike the sibling sentinel-contract suite, which
 * deliberately uses the real writer): disk-load timing is the
 * nondeterministic boundary under test, and only a controllable load can hold
 * the initial read open while a mutation completes. The fake preserves the
 * real store's contract - `load()` never rejects, `save()` mutates the
 * backing value, mark's readback load sees the post-save value.
 */

type Deferred = {
  readonly promise: Promise<HostRemovalState>;
  readonly resolve: (value: HostRemovalState) => void;
};

function deferred(): Deferred {
  let resolve: (value: HostRemovalState) => void = () => undefined;
  const promise = new Promise<HostRemovalState>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// Mutable fake-store state, reset per test. `deferredLoads` holds loads that
// were captured instead of resolving immediately; each entry also snapshots
// the disk value AT CALL TIME, which is what a real slow read would return.
let diskValue: HostRemovalState;
let loadCalls: number;
let deferNextLoad: boolean;
let capturedLoads: Array<{ gate: Deferred; snapshot: HostRemovalState }>;

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => "/tmp/unused-by-faked-store"),
    isPackaged: false,
    getAppPath: vi.fn(() => "/tmp"),
  },
}));

vi.mock("electron-log", () => ({
  default: {
    transports: { file: { level: "info" }, console: { level: "info" } },
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("../../app/json-file-store", () => ({
  createJsonFileStore: () => ({
    load: (): Promise<HostRemovalState> => {
      loadCalls += 1;
      if (deferNextLoad) {
        deferNextLoad = false;
        const entry = { gate: deferred(), snapshot: { ...diskValue } };
        capturedLoads.push(entry);
        return entry.gate.promise;
      }
      return Promise.resolve({ ...diskValue });
    },
    save: (value: HostRemovalState): Promise<void> => {
      diskValue = { ...value };
      return Promise.resolve();
    },
    saveStrict: (value: HostRemovalState): Promise<void> => {
      diskValue = { ...value };
      return Promise.resolve();
    },
    flush: (): Promise<void> => Promise.resolve(),
  }),
}));

const {
  __resetHostRemovalStateForTest,
  clearHostRemovedByUser,
  isHostRemovedByUser,
  markHostRemovedByUser,
} = await import("../host-removal-state");

/** Release captured load N with the disk snapshot it would really have read. */
function releaseCapturedLoad(index: number): void {
  const entry = capturedLoads[index];
  entry.gate.resolve(entry.snapshot);
}

describe("host-removal-state: initial load vs completed mutation", () => {
  beforeEach(() => {
    diskValue = { removedByUser: false };
    loadCalls = 0;
    deferNextLoad = false;
    capturedLoads = [];
    __resetHostRemovalStateForTest();
  });

  afterEach(() => {
    __resetHostRemovalStateForTest();
  });

  it("a stale initial load cannot overwrite a completed mark", async () => {
    // 1. First read begins; its disk load is held open (snapshot: false).
    deferNextLoad = true;
    const firstRead = isHostRemovedByUser();

    // 2. The user's removal completes fully while that load is in flight:
    //    persisted, readback-confirmed, cache installed.
    await markHostRemovedByUser();

    // 3. The slow load finally resolves with its pre-mark snapshot.
    releaseCapturedLoad(0);

    // The in-flight read must yield the post-mutation truth, not its stale
    // snapshot...
    await expect(firstRead).resolves.toBe(true);
    // ...and, decisive for the product: later gates must keep seeing it.
    // Before the adopt-once guard, the stale snapshot overwrote the cache
    // here and every converge/respawn gate read `false` until restart.
    await expect(isHostRemovedByUser()).resolves.toBe(true);
  });

  it("a stale initial load cannot resurrect a cleared sentinel", async () => {
    // Device starts in the removed state.
    diskValue = { removedByUser: true };

    deferNextLoad = true;
    const firstRead = isHostRemovedByUser();

    // Reinstall clears the sentinel while the load is in flight.
    await clearHostRemovedByUser();

    releaseCapturedLoad(0);

    await expect(firstRead).resolves.toBe(false);
    await expect(isHostRemovedByUser()).resolves.toBe(false);
  });

  it("concurrent first reads share one disk load", async () => {
    deferNextLoad = true;
    const a = isHostRemovedByUser();
    const b = isHostRemovedByUser();

    releaseCapturedLoad(0);

    await expect(a).resolves.toBe(false);
    await expect(b).resolves.toBe(false);
    expect(loadCalls).toBe(1);
  });

  it("plain first read still adopts the disk value", async () => {
    diskValue = { removedByUser: true };
    await expect(isHostRemovedByUser()).resolves.toBe(true);
    // Cached now: no further loads.
    await expect(isHostRemovedByUser()).resolves.toBe(true);
    expect(loadCalls).toBe(1);
  });
});
