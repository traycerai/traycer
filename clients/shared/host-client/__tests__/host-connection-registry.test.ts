import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostLeaseSnapshot } from "../../host-selection/selection-authority-contract";
import type { Disposable } from "../../platform/uri-callback";
import type { HostDirectoryEntry } from "../host-directory";
import type { RemoteHostDirectoryEntry } from "../remote-fetcher";
import {
  HOST_CONNECTION_LINGER_MS,
  acquireHostConnection,
  hostConnectionRefCountForTest,
  hostDirectoryEntryEquals,
  hostLeaseSnapshotEquals,
  installHostConnectionRegistrySource,
  resetHostConnectionRegistry,
  resetHostConnectionRegistryForTest,
  subscribeAnyHostRowChanged,
  subscribeHostRowChanged,
} from "../host-connection-registry";

// `installHostConnectionRegistrySource` replaces the previous wiring rather
// than merging with it, so every test builds and installs its own stub
// source.
//
// `resetHostConnectionRegistry()` is the PRODUCTION reset (`HostRuntime.
// dispose()`) and deliberately keeps subscribers alive across it - a
// StrictMode double-invoke disposes and rebuilds the runtime while every
// consumer stays mounted, so clearing listeners there would leave them
// subscribed to nothing forever. `resetHostConnectionRegistryForTest()` is
// the full clear (subscribers included), and is what `afterEach` uses below:
// suites share this module, so a suite that left a listener behind would
// fire it into the next suite's assertions.

interface StubDirectory {
  readonly source: {
    readonly findById: (hostId: string) => HostDirectoryEntry | null;
    readonly onDirectoryChanged: (listener: () => void) => Disposable;
  };
  setEntry(hostId: string, entry: HostDirectoryEntry): void;
  removeEntry(hostId: string): void;
  /** Fires the list-wide change event WITHOUT necessarily changing any row -
   * this is what `findById` returning a fresh object on every read models: a
   * directory refresh that rebuilt every row, whether or not the fields moved. */
  emitChanged(): void;
}

function stubDirectory(): StubDirectory {
  const rows = new Map<string, HostDirectoryEntry>();
  const listeners = new Set<() => void>();
  return {
    source: {
      // Fresh object per call, exactly like production `findById` (the local
      // row is rebuilt per snapshot / crosses IPC as a new object) - the
      // suppression logic under test exists entirely because of this.
      findById: (hostId) => {
        const row = rows.get(hostId);
        return row === undefined ? null : { ...row };
      },
      onDirectoryChanged: (listener) => {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      },
    },
    setEntry: (hostId, entry) => rows.set(hostId, entry),
    removeEntry: (hostId) => rows.delete(hostId),
    emitChanged: () => {
      for (const listener of [...listeners]) listener();
    },
  };
}

interface StubLeases {
  readonly source: {
    readonly leaseFor: (hostId: string) => HostLeaseSnapshot | null;
    readonly onLeasesChanged: (listener: () => void) => Disposable;
  };
  setLease(hostId: string, lease: HostLeaseSnapshot | null): void;
  emitChanged(): void;
}

function stubLeases(): StubLeases {
  const leases = new Map<string, HostLeaseSnapshot | null>();
  const listeners = new Set<() => void>();
  return {
    source: {
      leaseFor: (hostId) => leases.get(hostId) ?? null,
      onLeasesChanged: (listener) => {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      },
    },
    setLease: (hostId, lease) => leases.set(hostId, lease),
    emitChanged: () => {
      for (const listener of [...listeners]) listener();
    },
  };
}

function localEntry(
  hostId: string,
  overrides: Partial<HostDirectoryEntry>,
): HostDirectoryEntry {
  return {
    hostId,
    label: `label-${hostId}`,
    kind: "local",
    websocketUrl: "ws://127.0.0.1:9000",
    version: "1.0.0",
    transportDialability: "dialable",
    ...overrides,
  };
}

function remoteEntry(
  hostId: string,
  overrides: Partial<RemoteHostDirectoryEntry>,
): RemoteHostDirectoryEntry {
  return {
    hostId,
    label: `label-${hostId}`,
    kind: "remote",
    websocketUrl: "wss://relay.test/attach",
    version: "1.0.0",
    transportDialability: "not-dialable",
    publicKey: `pubkey-${hostId}`,
    relayFuseGrace: false,
    remoteStatus: {
      connectivity: "offline",
      viewerReachability: "unknown",
      clientCloud: "ok",
      updateState: "current",
      appVersion: "1.0.0",
      lastSeenAt: null,
    },
    ...overrides,
  };
}

let nextHostId = 0;
function freshHostId(): string {
  nextHostId += 1;
  return `host-${nextHostId}`;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  resetHostConnectionRegistryForTest();
  vi.useRealTimers();
});

describe("subscribeHostRowChanged — per-host precision", () => {
  it("does NOT notify a subscriber for host A when only host B's row changes", () => {
    const directory = stubDirectory();
    const hostA = freshHostId();
    const hostB = freshHostId();
    directory.setEntry(hostA, localEntry(hostA, {}));
    directory.setEntry(hostB, localEntry(hostB, {}));
    installHostConnectionRegistrySource({
      directory: directory.source,
      leases: null,
    });

    const listenerA = vi.fn();
    subscribeHostRowChanged(hostA, listenerA);
    // Give host B a record too, so its own row has something to compare
    // against and genuinely change.
    const listenerB = vi.fn();
    subscribeHostRowChanged(hostB, listenerB);

    directory.setEntry(hostB, localEntry(hostB, { label: "renamed" }));
    directory.emitChanged();

    expect(listenerB).toHaveBeenCalledTimes(1);
    expect(listenerA).not.toHaveBeenCalled();
  });

  it("suppresses a directory emit whose rows are field-identical, even though findById returns a fresh object every call", () => {
    const directory = stubDirectory();
    const hostId = freshHostId();
    directory.setEntry(hostId, localEntry(hostId, {}));
    installHostConnectionRegistrySource({
      directory: directory.source,
      leases: null,
    });

    const listener = vi.fn();
    subscribeHostRowChanged(hostId, listener);

    // No field of the stored row changed - only a fresh object was handed
    // back, exactly like the real `findById`.
    directory.emitChanged();

    expect(listener).not.toHaveBeenCalled();
  });

  it("the coarse arm fires even for a host with NO record — the host nobody has named yet", () => {
    const directory = stubDirectory();
    installHostConnectionRegistrySource({
      directory: directory.source,
      leases: null,
    });

    const coarseListener = vi.fn();
    subscribeAnyHostRowChanged(coarseListener);

    // A host with no subscriber and no record arrives; the per-host arm has
    // nothing to compare, but the coarse arm must still fire, or a consumer
    // that resolves its own host id at read time (and so cannot name it at
    // subscribe time) is never woken.
    directory.setEntry(freshHostId(), localEntry(freshHostId(), {}));
    directory.emitChanged();

    expect(coarseListener).toHaveBeenCalledTimes(1);
  });

  it("the coarse arm fires unconditionally on every source emit, independent of any per-host suppression", () => {
    const directory = stubDirectory();
    const hostId = freshHostId();
    directory.setEntry(hostId, localEntry(hostId, {}));
    installHostConnectionRegistrySource({
      directory: directory.source,
      leases: null,
    });

    const perHostListener = vi.fn();
    subscribeHostRowChanged(hostId, perHostListener);
    const coarseListener = vi.fn();
    subscribeAnyHostRowChanged(coarseListener);

    // No field changed - the per-host arm is suppressed, but the coarse arm
    // fires anyway (this is the documented asymmetry, not an oversight).
    directory.emitChanged();

    expect(perHostListener).not.toHaveBeenCalled();
    expect(coarseListener).toHaveBeenCalledTimes(1);
  });

  it("notifies a per-host subscriber when that host's row ARRIVES for the first time (null -> present)", () => {
    // The arrival path: a consumer subscribed before the directory ever had
    // this host's row (the ordinary case for a freshly-booted local host that
    // has not published yet). This is the half `useHostDirectoryEntry` is
    // built to replace after P4.2 deletes the old slot event, and it is
    // structurally distinct from every "row already present, then changes"
    // case above - `record.entry` starts at `null`, not at some prior row.
    const directory = stubDirectory();
    const hostId = freshHostId();
    // Deliberately no `directory.setEntry(hostId, ...)` yet - `findById`
    // answers `null` for this host at subscribe time.
    installHostConnectionRegistrySource({
      directory: directory.source,
      leases: null,
    });

    const perHostListener = vi.fn();
    subscribeHostRowChanged(hostId, perHostListener);
    const coarseListener = vi.fn();
    subscribeAnyHostRowChanged(coarseListener);
    expect(perHostListener).not.toHaveBeenCalled();

    directory.setEntry(hostId, localEntry(hostId, {}));
    directory.emitChanged();

    // The PER-HOST listener specifically, not the (unconditional) coarse
    // one - a mutation that suppresses `null`-cached records would leave the
    // coarse arm firing while this exact assertion is what catches it.
    expect(perHostListener).toHaveBeenCalledTimes(1);
    expect(coarseListener).toHaveBeenCalledTimes(1);
  });

  it("notifies a per-host subscriber when that host's row DEPARTS (present -> null, a deregistration)", () => {
    // The mirror direction: a host that existed and then stops being
    // reported by the directory (deregistered, or the shell's snapshot
    // dropped it). `record.entry` goes from a real row to `null`, which is
    // still a genuine change and must still notify.
    const directory = stubDirectory();
    const hostId = freshHostId();
    directory.setEntry(hostId, localEntry(hostId, {}));
    installHostConnectionRegistrySource({
      directory: directory.source,
      leases: null,
    });

    const perHostListener = vi.fn();
    subscribeHostRowChanged(hostId, perHostListener);
    expect(perHostListener).not.toHaveBeenCalled();

    directory.removeEntry(hostId);
    directory.emitChanged();

    expect(perHostListener).toHaveBeenCalledTimes(1);
  });
});

describe("hostDirectoryEntryEquals — each field is load-bearing", () => {
  it("is true for two structurally-identical entries, even as different object references", () => {
    const hostId = freshHostId();
    const a = localEntry(hostId, {});
    const b = { ...a };
    expect(a).not.toBe(b);
    expect(hostDirectoryEntryEquals(a, b)).toBe(true);
  });

  it("treats null vs null as equal, and null vs a value as unequal", () => {
    expect(hostDirectoryEntryEquals(null, null)).toBe(true);
    expect(hostDirectoryEntryEquals(null, localEntry(freshHostId(), {}))).toBe(
      false,
    );
    expect(hostDirectoryEntryEquals(localEntry(freshHostId(), {}), null)).toBe(
      false,
    );
  });

  it("breaks on label, kind, websocketUrl, and version", () => {
    const hostId = freshHostId();
    const base = localEntry(hostId, {});
    expect(hostDirectoryEntryEquals(base, { ...base, label: "other" })).toBe(
      false,
    );
    expect(hostDirectoryEntryEquals(base, { ...base, kind: "mock" })).toBe(
      false,
    );
    expect(
      hostDirectoryEntryEquals(base, {
        ...base,
        websocketUrl: "ws://other:9000",
      }),
    ).toBe(false);
    expect(hostDirectoryEntryEquals(base, { ...base, version: "2.0.0" })).toBe(
      false,
    );
  });

  it("breaks on the derived hostUnavailability verdict (not the coarse transportDialability bit alone)", () => {
    const hostId = freshHostId();
    // Two remote entries both `not-dialable`, so the coarse bit is identical
    // on both sides - only the connectivity-derived reason differs
    // (indeterminate vs offline). `hostDirectoryEntryEquals` must still catch
    // this, per its own documented reasoning.
    const indeterminate = remoteEntry(hostId, {
      remoteStatus: {
        connectivity: "unknown",
        viewerReachability: "unknown",
        clientCloud: "ok",
        updateState: "current",
        appVersion: "1.0.0",
        lastSeenAt: null,
      },
    });
    const offline = remoteEntry(hostId, {
      remoteStatus: {
        connectivity: "offline",
        viewerReachability: "unknown",
        clientCloud: "ok",
        updateState: "current",
        appVersion: "1.0.0",
        lastSeenAt: null,
      },
    });
    expect(hostUnavailabilityDiffers(indeterminate, offline)).toBe(true);
    expect(hostDirectoryEntryEquals(indeterminate, offline)).toBe(false);
  });

  it("breaks on isRelayFuseRecoveryCandidate — recency aging past the fuse cap flips this while every other field stays identical", () => {
    const hostId = freshHostId();
    const withinFuseWindow = remoteEntry(hostId, { relayFuseGrace: true });
    const pastFuseWindow = { ...withinFuseWindow, relayFuseGrace: false };
    expect(hostDirectoryEntryEquals(withinFuseWindow, pastFuseWindow)).toBe(
      false,
    );
  });

  it("breaks on the remote publicKey — a same-host key rotation leaves every base field byte-identical", () => {
    const hostId = freshHostId();
    const rotatedFrom = remoteEntry(hostId, { publicKey: "pubkey-old" });
    const rotatedTo = { ...rotatedFrom, publicKey: "pubkey-new" };
    expect(hostDirectoryEntryEquals(rotatedFrom, rotatedTo)).toBe(false);
  });

  it("a local entry's absent publicKey never breaks equality with itself", () => {
    const hostId = freshHostId();
    const a = localEntry(hostId, {});
    const b = { ...a };
    expect(hostDirectoryEntryEquals(a, b)).toBe(true);
  });
});

/** Local helper mirroring the module's own derivation, for the assertion's own sanity check. */
function hostUnavailabilityDiffers(
  a: RemoteHostDirectoryEntry,
  b: RemoteHostDirectoryEntry,
): boolean {
  return a.remoteStatus.connectivity !== b.remoteStatus.connectivity;
}

describe("hostLeaseSnapshotEquals", () => {
  it("two leases with the same non-dead status are equal", () => {
    const a: HostLeaseSnapshot = { hostId: "h", status: "ready", dead: null };
    const b: HostLeaseSnapshot = { hostId: "h", status: "ready", dead: null };
    expect(hostLeaseSnapshotEquals(a, b)).toBe(true);
  });

  it("differs on hostId or status alone", () => {
    const ready: HostLeaseSnapshot = {
      hostId: "h",
      status: "ready",
      dead: null,
    };
    expect(hostLeaseSnapshotEquals(ready, { ...ready, hostId: "other" })).toBe(
      false,
    );
    expect(
      hostLeaseSnapshotEquals(ready, { ...ready, status: "degraded" }),
    ).toBe(false);
  });

  it("two dead leases with different dead.reason are NOT equal", () => {
    const offline: HostLeaseSnapshot = {
      hostId: "h",
      status: "dead",
      dead: { reason: "offline" },
    };
    const planRestricted: HostLeaseSnapshot = {
      hostId: "h",
      status: "dead",
      dead: { reason: "plan-restricted" },
    };
    expect(hostLeaseSnapshotEquals(offline, planRestricted)).toBe(false);
  });

  // `HostLeaseDeadState` is a discriminated union, and only the
  // `incompatible` arm carries `detail` - so every lease below is built as a
  // full literal on that arm rather than spread through a narrower type.
  const BASE_INCOMPATIBLE_DETAIL = {
    code: "host-too-old",
    hostVersion: "1.0.0",
    minSupportedVersion: "1.2.0",
  } as const;

  it("two incompatible leases differing only in detail.code are NOT equal", () => {
    const a: HostLeaseSnapshot = {
      hostId: "h",
      status: "dead",
      dead: { reason: "incompatible", detail: BASE_INCOMPATIBLE_DETAIL },
    };
    const b: HostLeaseSnapshot = {
      hostId: "h",
      status: "dead",
      dead: {
        reason: "incompatible",
        detail: { ...BASE_INCOMPATIBLE_DETAIL, code: "client-too-old" },
      },
    };
    expect(hostLeaseSnapshotEquals(a, b)).toBe(false);
  });

  it("two incompatible leases differing only in detail.hostVersion are NOT equal", () => {
    const a: HostLeaseSnapshot = {
      hostId: "h",
      status: "dead",
      dead: { reason: "incompatible", detail: BASE_INCOMPATIBLE_DETAIL },
    };
    const b: HostLeaseSnapshot = {
      hostId: "h",
      status: "dead",
      dead: {
        reason: "incompatible",
        detail: { ...BASE_INCOMPATIBLE_DETAIL, hostVersion: "1.0.1" },
      },
    };
    expect(hostLeaseSnapshotEquals(a, b)).toBe(false);
  });

  it("two incompatible leases differing only in detail.minSupportedVersion are NOT equal", () => {
    const a: HostLeaseSnapshot = {
      hostId: "h",
      status: "dead",
      dead: { reason: "incompatible", detail: BASE_INCOMPATIBLE_DETAIL },
    };
    const b: HostLeaseSnapshot = {
      hostId: "h",
      status: "dead",
      dead: {
        reason: "incompatible",
        detail: {
          ...BASE_INCOMPATIBLE_DETAIL,
          minSupportedVersion: "1.3.0",
        },
      },
    };
    expect(hostLeaseSnapshotEquals(a, b)).toBe(false);
  });

  it("two incompatible leases with identical detail fields ARE equal", () => {
    const a: HostLeaseSnapshot = {
      hostId: "h",
      status: "dead",
      dead: { reason: "incompatible", detail: BASE_INCOMPATIBLE_DETAIL },
    };
    const b: HostLeaseSnapshot = {
      hostId: "h",
      status: "dead",
      dead: {
        reason: "incompatible",
        detail: { ...BASE_INCOMPATIBLE_DETAIL },
      },
    };
    expect(a.dead).not.toBe(b.dead);
    expect(hostLeaseSnapshotEquals(a, b)).toBe(true);
  });

  it("null vs null is equal; null vs a value is not", () => {
    expect(hostLeaseSnapshotEquals(null, null)).toBe(true);
    const lease: HostLeaseSnapshot = {
      hostId: "h",
      status: "ready",
      dead: null,
    };
    expect(hostLeaseSnapshotEquals(null, lease)).toBe(false);
    expect(hostLeaseSnapshotEquals(lease, null)).toBe(false);
  });
});

describe("acquireHostConnection — ref-count and keep-warm linger", () => {
  it("two acquires then one release keeps the record (still referenced)", () => {
    const directory = stubDirectory();
    const hostId = freshHostId();
    directory.setEntry(hostId, localEntry(hostId, {}));
    installHostConnectionRegistrySource({
      directory: directory.source,
      leases: null,
    });

    const first = acquireHostConnection(hostId);
    const second = acquireHostConnection(hostId);
    expect(hostConnectionRefCountForTest(hostId)).toBe(2);

    first.release();
    expect(hostConnectionRefCountForTest(hostId)).toBe(1);
    // Not lingering - a live reference is still held.
    vi.advanceTimersByTime(HOST_CONNECTION_LINGER_MS * 2);
    expect(hostConnectionRefCountForTest(hostId)).toBe(1);

    second.release();
  });

  it("the last release starts the linger, and only its expiry drops the record", () => {
    const directory = stubDirectory();
    const hostId = freshHostId();
    directory.setEntry(hostId, localEntry(hostId, {}));
    installHostConnectionRegistrySource({
      directory: directory.source,
      leases: null,
    });

    const lease = acquireHostConnection(hostId);
    lease.release();
    expect(hostConnectionRefCountForTest(hostId)).toBe(0);

    vi.advanceTimersByTime(HOST_CONNECTION_LINGER_MS - 1);
    // Still present just before the window closes - a subscriber attached
    // here would still get a listener registered against a live record.
    const stillLingering = vi.fn();
    const unsubscribe = subscribeHostRowChanged(hostId, stillLingering);
    unsubscribe();

    vi.advanceTimersByTime(1);
    // Past the window: a fresh acquire re-reads the source rather than
    // reusing bookkeeping that should have been dropped. There is no direct
    // "record exists" accessor, so this is asserted indirectly through
    // ref-count starting over at a clean 1 with no stale listeners.
    const reacquired = acquireHostConnection(hostId);
    expect(hostConnectionRefCountForTest(hostId)).toBe(1);
    reacquired.release();
  });

  it("a re-acquire inside the linger window adopts the warm record instead of starting a fresh one", () => {
    const directory = stubDirectory();
    const hostId = freshHostId();
    directory.setEntry(hostId, localEntry(hostId, {}));
    installHostConnectionRegistrySource({
      directory: directory.source,
      leases: null,
    });

    const first = acquireHostConnection(hostId);
    first.release();
    vi.advanceTimersByTime(HOST_CONNECTION_LINGER_MS - 1);

    const second = acquireHostConnection(hostId);
    expect(hostConnectionRefCountForTest(hostId)).toBe(1);

    // The pending teardown was cancelled by the re-acquire, not merely
    // outpaced: even well past the original deadline the record survives.
    vi.advanceTimersByTime(HOST_CONNECTION_LINGER_MS * 3);
    expect(hostConnectionRefCountForTest(hostId)).toBe(1);

    second.release();
  });

  it("release() is idempotent — calling it twice never double-decrements", () => {
    const directory = stubDirectory();
    const hostId = freshHostId();
    directory.setEntry(hostId, localEntry(hostId, {}));
    installHostConnectionRegistrySource({
      directory: directory.source,
      leases: null,
    });

    const other = acquireHostConnection(hostId);
    const view = acquireHostConnection(hostId);
    view.release();
    view.release();
    expect(hostConnectionRefCountForTest(hostId)).toBe(1);
    other.release();
  });
});

describe("resetHostConnectionRegistry — production StrictMode-remount semantics", () => {
  it("keeps a subscribed listener alive across reset + reinstall (StrictMode double-invoke) — a genuine row change under the NEW source still reaches it", () => {
    // Models React's setup-cleanup-setup double-invoke: `HostRuntime.
    // dispose()` (this reset) then a fresh `start()` (a new source, same
    // rendered consumer) - the consumer never unmounted, so its subscription
    // must survive. If the reset instead dropped listeners (the bug being
    // fixed), this would see zero calls no matter what the new source says.
    //
    // The NOTE that stood here recorded the OLD install behaviour - a silent
    // adopt loop that overwrote every cached answer with no equality check and
    // no notification - and concluded the cache half of reset's contract was
    // not observable through this path. That silence was itself the defect
    // (Codex #1243 T-59): a subscriber surviving the remount, which is exactly
    // what this test establishes, holds its pre-reset snapshot forever when
    // the new source's answer differs and no later change happens to arrive.
    // `installHostConnectionRegistrySource` now reconciles like any other
    // change event, so the install IS observable, and this test asserts both
    // halves: the adopt notifies for a row that moved, and the subscription
    // still receives an ordinary later change.
    const hostId = freshHostId();
    const oldDirectory = stubDirectory();
    oldDirectory.setEntry(hostId, localEntry(hostId, {}));
    installHostConnectionRegistrySource({
      directory: oldDirectory.source,
      leases: null,
    });

    const listener = vi.fn();
    subscribeHostRowChanged(hostId, listener);
    oldDirectory.emitChanged();
    expect(listener).not.toHaveBeenCalled();

    resetHostConnectionRegistry();

    const newDirectory = stubDirectory();
    newDirectory.setEntry(hostId, localEntry(hostId, { label: "renamed" }));
    installHostConnectionRegistrySource({
      directory: newDirectory.source,
      leases: null,
    });
    // The install itself now reports: `resetHostConnectionRegistry` nulled the
    // cached answer and the new source has a row, so this record's answer
    // genuinely moved and a survivor has to hear about it. This is the arm
    // that was silent before the fix.
    expect(listener).toHaveBeenCalledTimes(1);

    // ...and the subscription is still attached for ordinary later changes,
    // which is the original subject of this test.
    newDirectory.setEntry(
      hostId,
      localEntry(hostId, { label: "renamed-again" }),
    );
    newDirectory.emitChanged();

    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("drops a record that has neither a subscriber nor a holder", () => {
    const directory = stubDirectory();
    const hostId = freshHostId();
    directory.setEntry(hostId, localEntry(hostId, {}));
    installHostConnectionRegistrySource({
      directory: directory.source,
      leases: null,
    });

    acquireHostConnection(hostId).release();
    resetHostConnectionRegistry();

    // Nothing kept this record alive (no subscriber, no holder), so it was
    // dropped - a fresh acquire starts a clean ref-count rather than
    // inheriting stale bookkeeping.
    installHostConnectionRegistrySource({
      directory: directory.source,
      leases: null,
    });
    const lease = acquireHostConnection(hostId);
    expect(hostConnectionRefCountForTest(hostId)).toBe(1);
    lease.release();
  });

  it("clears an armed linger timer rather than letting it fire against whatever reoccupies the slot", () => {
    const directory = stubDirectory();
    const hostId = freshHostId();
    directory.setEntry(hostId, localEntry(hostId, {}));
    installHostConnectionRegistrySource({
      directory: directory.source,
      leases: null,
    });

    acquireHostConnection(hostId).release();
    // Linger armed, not yet expired.
    resetHostConnectionRegistry();

    installHostConnectionRegistrySource({
      directory: directory.source,
      leases: null,
    });
    // If the old timer were still armed it would delete a record that
    // doesn't exist under the new registration - advancing time must not
    // throw or corrupt a fresh acquire made in the meantime.
    const lease = acquireHostConnection(hostId);
    vi.advanceTimersByTime(HOST_CONNECTION_LINGER_MS * 2);
    expect(hostConnectionRefCountForTest(hostId)).toBe(1);
    lease.release();
  });
});

describe("resetHostConnectionRegistryForTest — full clear (test-only)", () => {
  it("leaves no listeners and no records — a subsequent directory emit reaches nobody", () => {
    const directory = stubDirectory();
    const hostId = freshHostId();
    directory.setEntry(hostId, localEntry(hostId, {}));
    installHostConnectionRegistrySource({
      directory: directory.source,
      leases: null,
    });

    const perHostListener = vi.fn();
    subscribeHostRowChanged(hostId, perHostListener);
    const coarseListener = vi.fn();
    subscribeAnyHostRowChanged(coarseListener);
    acquireHostConnection(hostId);

    resetHostConnectionRegistryForTest();
    expect(hostConnectionRefCountForTest(hostId)).toBe(0);

    // Reinstall a fresh source and fire it: neither old listener should ever
    // fire again, because the test reset dropped the subscription to the OLD
    // source too (`disposeSourceSubscriptions`) as well as the listener sets
    // themselves - unlike the production reset above.
    const freshDirectory = stubDirectory();
    freshDirectory.setEntry(hostId, localEntry(hostId, { label: "changed" }));
    installHostConnectionRegistrySource({
      directory: freshDirectory.source,
      leases: null,
    });
    freshDirectory.emitChanged();
    directory.emitChanged();

    expect(perHostListener).not.toHaveBeenCalled();
    expect(coarseListener).not.toHaveBeenCalled();
  });
});

describe("lease reads come from the installed source, never a cached copy", () => {
  it("changing what leaseFor returns changes the next status() read", () => {
    const directory = stubDirectory();
    const leases = stubLeases();
    const hostId = freshHostId();
    directory.setEntry(hostId, localEntry(hostId, {}));
    const connecting: HostLeaseSnapshot = {
      hostId,
      status: "connecting",
      dead: null,
    };
    leases.setLease(hostId, connecting);
    installHostConnectionRegistrySource({
      directory: directory.source,
      leases: leases.source,
    });

    const lease = acquireHostConnection(hostId);
    expect(lease.status()).toEqual(connecting);

    const ready: HostLeaseSnapshot = { hostId, status: "ready", dead: null };
    leases.setLease(hostId, ready);
    // No `onLeasesChanged` emit yet - `status()` reads through the source at
    // call time rather than serving a snapshot cached at acquire time.
    expect(lease.status()).toEqual(ready);

    lease.release();
  });

  it("a source with leases: null answers every status() with null rather than throwing", () => {
    const directory = stubDirectory();
    const hostId = freshHostId();
    directory.setEntry(hostId, localEntry(hostId, {}));
    installHostConnectionRegistrySource({
      directory: directory.source,
      leases: null,
    });

    const lease = acquireHostConnection(hostId);
    expect(lease.status()).toBeNull();
    lease.release();
  });

  it("leaseFor changing AND onLeasesChanged firing notifies a per-host subscriber, honoring hostLeaseSnapshotEquals suppression", () => {
    const directory = stubDirectory();
    const leases = stubLeases();
    const hostId = freshHostId();
    directory.setEntry(hostId, localEntry(hostId, {}));
    leases.setLease(hostId, { hostId, status: "connecting", dead: null });
    installHostConnectionRegistrySource({
      directory: directory.source,
      leases: leases.source,
    });

    const listener = vi.fn();
    subscribeHostRowChanged(hostId, listener);

    // Same status - no observable change - must not notify.
    leases.setLease(hostId, { hostId, status: "connecting", dead: null });
    leases.emitChanged();
    expect(listener).not.toHaveBeenCalled();

    leases.setLease(hostId, { hostId, status: "ready", dead: null });
    leases.emitChanged();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
