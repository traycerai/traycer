import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AuthorityIdentitySource,
  HostFleetSnapshot,
  SelectionSubscription,
} from "@traycer-clients/shared/host-selection/selection-authority-contract";
import type { AuthorityLog } from "@traycer-clients/shared/host-selection/selection-authority-engine";
import type { HostListFetchResult } from "@traycer-clients/shared/host-client/remote-fetcher";
import type { HostListItem } from "@traycer/protocol/host/host-status";
import type {
  IpcHostController,
  IpcHostLifecycle,
} from "../../ipc/runner-ipc-bridge";
import type {
  HostControllerStatus,
  LifecycleAdmissionBlock,
} from "../../host/host-controller-types";
import type {
  ActivateInstalledOk,
  ApplyStagedOk,
  ApplyStagedTrigger,
  ConvergeReadyOk,
  InstallVersionOk,
  MutationOutcome,
  MutationProgress,
  RemoveTraycerOk,
  ServiceRegistrationOk,
  UninstallOk,
} from "../../host/host-controller-types";
import type {
  DesktopPublishedHostSnapshot,
  RegisteredHostsPush,
} from "../../../ipc-contracts/host-types";
import { DesktopAuthSession } from "../../auth/desktop-auth-session";
import {
  createDesktopLocalHostEnsurePort,
  DesktopAuthorityIdentitySource,
  DesktopHostFleetSource,
  DesktopLocalHostOutageSignal,
} from "../desktop-selection-ports";

const silentLog: AuthorityLog = {
  debug: () => undefined,
  warn: () => undefined,
};

function signedInSnapshot(userId: string, token: string) {
  return {
    status: "signed-in" as const,
    token,
    profile: { userId, userName: userId, email: `${userId}@example.com` },
  };
}

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "selection-ports-test-"));
  tempDirs.push(dir);
  return dir;
}

async function writeEnrollment(dir: string, hostId: string): Promise<string> {
  const file = join(dir, "enrollment.json");
  await mkdir(dir, { recursive: true });
  await writeFile(file, JSON.stringify({ hostId }), "utf8");
  return file;
}

afterEach(async () => {
  tempDirs.length = 0;
});

/**
 * Local-identity re-reads go through real `fs.readFile` (libuv I/O, not just
 * a microtask), so a couple of `Promise.resolve()` turns are not enough to
 * observe their completion. A real macrotask tick is.
 */
function flushIo(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

/**
 * A `listRegisteredHosts` double that hands every caller its OWN deferred and
 * announces when each call STARTS.
 *
 * ## Why the obvious shape is a deadlock
 *
 * The natural double for "two overlapping refreshes" is one keyed on call
 * order - `calls.length === 1 ? firstCall : secondCall`. It encodes an
 * assumption that is not true: WHICH refresh arrives first is decided by an
 * async race, not by the order the test started them. `refreshOrThrow` awaits
 * `readLocalHostId()` - a REAL filesystem read - before it ever calls this
 * double, so two overlapping refreshes are both suspended in libuv's
 * threadpool, and under a saturated pool their reads complete out of
 * submission order. When the second refresh wins, it receives `firstCall`, the
 * test resolves `firstCall` believing it belongs to the first refresh, and
 * `await inFlight` then waits on a deferred the test only resolves AFTER that
 * await. That is a HANG, not slowness - no timeout budget can fix an await
 * that never settles, which is why this is a fixture bug and not a timing one.
 *
 * ## What this replaces it with
 *
 * Per-call deferreds (so no call can be mistaken for another) plus a start
 * signal per call, so a test can WAIT for the fact it needs - "refresh #1 is
 * now inside the fetch" - instead of assuming it. The signal is resolved from
 * inside the double itself, so it is exact under any load. `flushIo`'s 10ms
 * sleep is the weaker form of the same barrier and is deliberately not used
 * for this: a sleep long enough today is a sleep too short on a busier
 * machine.
 */
function recordingRegistryFetch(): {
  readonly fetch: () => Promise<HostListFetchResult>;
  readonly calls: Array<Deferred<HostListFetchResult>>;
  readonly started: (index: number) => Promise<void>;
} {
  const calls: Array<Deferred<HostListFetchResult>> = [];
  const startSignals: Array<Deferred<void>> = [];
  const signalAt = (index: number): Deferred<void> => {
    while (startSignals.length <= index) {
      startSignals.push(deferred<void>());
    }
    const signal = startSignals[index];
    if (signal === undefined) {
      throw new Error(`no start signal for call ${index}`);
    }
    return signal;
  };
  return {
    calls,
    started: (index) => signalAt(index).promise,
    fetch: () => {
      const call = deferred<HostListFetchResult>();
      calls.push(call);
      signalAt(calls.length - 1).resolve();
      return call.promise;
    },
  };
}

// ---------------------------------------------------------------------------
// DesktopAuthorityIdentitySource
// ---------------------------------------------------------------------------

describe("DesktopAuthorityIdentitySource", () => {
  it("does not bump the generation or fire onChanged on a token-only refresh (same user)", () => {
    const authSession = new DesktopAuthSession();
    authSession.set(signedInSnapshot("user-a", "token-1"));
    const identity = new DesktopAuthorityIdentitySource(authSession);
    expect(identity.current()).toEqual({
      identityKey: "user-a",
      generation: 0,
    });

    const seen: Array<{ identityKey: string | null; generation: number }> = [];
    identity.onChanged((next) => seen.push(next));

    authSession.set(signedInSnapshot("user-a", "token-2"));

    expect(identity.current()).toEqual({
      identityKey: "user-a",
      generation: 0,
    });
    expect(seen).toEqual([]);
    identity.dispose();
  });

  it("bumps the generation and delivers the new identity on a different signed-in user", () => {
    const authSession = new DesktopAuthSession();
    authSession.set(signedInSnapshot("user-a", "token-1"));
    const identity = new DesktopAuthorityIdentitySource(authSession);

    const seen: Array<{ identityKey: string | null; generation: number }> = [];
    identity.onChanged((next) => seen.push(next));

    authSession.set(signedInSnapshot("user-b", "token-2"));

    expect(seen).toEqual([{ identityKey: "user-b", generation: 1 }]);
    expect(identity.current()).toEqual({
      identityKey: "user-b",
      generation: 1,
    });
    identity.dispose();
  });

  it("counts sign-out and sign-back-in-as-the-same-user as two transitions", () => {
    const authSession = new DesktopAuthSession();
    authSession.set(signedInSnapshot("user-a", "token-1"));
    const identity = new DesktopAuthorityIdentitySource(authSession);

    const seen: Array<{ identityKey: string | null; generation: number }> = [];
    identity.onChanged((next) => seen.push(next));

    authSession.set({ status: "signed-out", token: null, profile: null });
    expect(identity.current()).toEqual({ identityKey: null, generation: 1 });

    authSession.set(signedInSnapshot("user-a", "token-3"));
    expect(identity.current()).toEqual({
      identityKey: "user-a",
      generation: 2,
    });

    expect(seen).toEqual([
      { identityKey: null, generation: 1 },
      { identityKey: "user-a", generation: 2 },
    ]);
    identity.dispose();
  });

  it("current() is authoritative at any point, and dispose() unsubscribes from later auth-session changes", () => {
    const authSession = new DesktopAuthSession();
    authSession.set(signedInSnapshot("user-a", "token-1"));
    const identity = new DesktopAuthorityIdentitySource(authSession);
    expect(identity.current()).toEqual({
      identityKey: "user-a",
      generation: 0,
    });

    const seen: Array<{ identityKey: string | null; generation: number }> = [];
    identity.onChanged((next) => seen.push(next));

    identity.dispose();
    authSession.set(signedInSnapshot("user-b", "token-2"));

    expect(seen).toEqual([]);
    // current() is frozen at whatever it held at dispose time - the source no
    // longer observes the auth session at all.
    expect(identity.current()).toEqual({
      identityKey: "user-a",
      generation: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// DesktopHostFleetSource
// ---------------------------------------------------------------------------

class FakeIdentitySource implements AuthorityIdentitySource {
  private identityKey: string | null;
  private generation: number;
  private readonly listeners = new Set<
    (identity: { identityKey: string | null; generation: number }) => void
  >();

  constructor(identityKey: string | null, generation: number) {
    this.identityKey = identityKey;
    this.generation = generation;
  }

  current(): { identityKey: string | null; generation: number } {
    return { identityKey: this.identityKey, generation: this.generation };
  }

  onChanged(
    listener: (identity: {
      identityKey: string | null;
      generation: number;
    }) => void,
  ): SelectionSubscription {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  set(identityKey: string | null, generation: number): void {
    this.identityKey = identityKey;
    this.generation = generation;
    const current = this.current();
    for (const listener of Array.from(this.listeners)) {
      listener(current);
    }
  }
}

class FakeHostLifecycle extends EventEmitter implements IpcHostLifecycle {
  pidMetadataFile = "/tmp/selection-ports-test/pid.json";
  identityEnrollmentFile = "/tmp/selection-ports-test/enrollment.json";
  isDisposed = false;

  getSnapshot(): DesktopPublishedHostSnapshot | null {
    return null;
  }
  notifyRespawning(): void {}
  noteEndpointAnswered(): void {}
  ensureWatcherInstalled(): void {}
  async reloadSnapshotFromDisk(): Promise<DesktopPublishedHostSnapshot | null> {
    return null;
  }
  async getRecentLogTail(_maxLines: number): Promise<string | null> {
    return null;
  }

  emitChange(): void {
    this.emit("change", null);
  }
}

function buildHostListItem(hostId: string): HostListItem {
  return {
    hostId,
    displayName: null,
    platform: null,
    kind: "personal",
    publicKey: "pub-key",
    createdAt: "2026-01-01T00:00:00.000Z",
    status: {
      connectivity: "connectable",
      viewerReachability: "ok",
      clientCloud: "ok",
      updateState: "current",
      appVersion: null,
      lastSeenAt: null,
    },
    updatePolicy: "manual",
  };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolveFn: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolveFn = resolve;
  });
  return { promise, resolve: resolveFn };
}

function buildFleetSource(overrides: {
  identity: AuthorityIdentitySource;
  authSession: DesktopAuthSession;
  host: FakeHostLifecycle;
  listRegisteredHosts: (
    authnBaseUrl: string,
    bearerToken: string,
  ) => Promise<HostListFetchResult>;
}): DesktopHostFleetSource {
  // A recording fake, not a no-op: `publishRegistryResponse` is a required
  // option (P4.1/F22), and callers that don't care what lands here still need
  // a real sink rather than a silently-dropping one. Tests that DO care what
  // was published use `buildFleetSourceWithPublisher` below instead.
  const published: RegisteredHostsPush[] = [];
  return new DesktopHostFleetSource({
    authnBaseUrl: "http://localhost:5005",
    identity: overrides.identity,
    authSession: overrides.authSession,
    host: overrides.host,
    listRegisteredHosts: overrides.listRegisteredHosts,
    publishRegistryResponse: (push) => {
      published.push(push);
    },
    log: silentLog,
  });
}

/**
 * Same composition as {@link buildFleetSource}, but hands back the recording
 * array too - for the P4.1/F22 `publishRegistryResponse` assertions, which
 * need to inspect what actually got published rather than just that the
 * option was wired.
 */
function buildFleetSourceWithPublisher(overrides: {
  identity: AuthorityIdentitySource;
  authSession: DesktopAuthSession;
  host: FakeHostLifecycle;
  listRegisteredHosts: (
    authnBaseUrl: string,
    bearerToken: string,
  ) => Promise<HostListFetchResult>;
}): {
  readonly fleet: DesktopHostFleetSource;
  readonly published: RegisteredHostsPush[];
} {
  const published: RegisteredHostsPush[] = [];
  const fleet = new DesktopHostFleetSource({
    authnBaseUrl: "http://localhost:5005",
    identity: overrides.identity,
    authSession: overrides.authSession,
    host: overrides.host,
    listRegisteredHosts: overrides.listRegisteredHosts,
    publishRegistryResponse: (push) => {
      published.push(push);
    },
    log: silentLog,
  });
  return { fleet, published };
}

describe("DesktopHostFleetSource", () => {
  it("maps registry rows to fleet entries carrying only hostId and kind", async () => {
    const dir = await makeTempDir();
    const enrollmentFile = await writeEnrollment(dir, "local-host");
    const authSession = new DesktopAuthSession();
    authSession.set(signedInSnapshot("user-a", "token-1"));
    const identity = new FakeIdentitySource("user-a", 0);
    const host = new FakeHostLifecycle();
    host.identityEnrollmentFile = enrollmentFile;
    const fleet = buildFleetSource({
      identity,
      authSession,
      host,
      listRegisteredHosts: async () => ({
        kind: "ok",
        response: { hosts: [buildHostListItem("local-host")] },
      }),
    });

    await fleet.refresh();

    expect(fleet.snapshot().hosts).toHaveLength(1);
    for (const entry of fleet.snapshot().hosts) {
      expect(Object.keys(entry).sort()).toEqual(["hostId", "kind"]);
    }
    fleet.dispose();
  });

  it("classifies the row matching this machine's durable id as local, the rest as remote", async () => {
    const dir = await makeTempDir();
    const enrollmentFile = await writeEnrollment(dir, "local-host");
    const authSession = new DesktopAuthSession();
    authSession.set(signedInSnapshot("user-a", "token-1"));
    const identity = new FakeIdentitySource("user-a", 0);
    const host = new FakeHostLifecycle();
    host.identityEnrollmentFile = enrollmentFile;
    const fleet = buildFleetSource({
      identity,
      authSession,
      host,
      listRegisteredHosts: async () => ({
        kind: "ok",
        response: {
          hosts: [
            buildHostListItem("local-host"),
            buildHostListItem("remote-host"),
          ],
        },
      }),
    });

    await fleet.refresh();

    expect(fleet.snapshot().hosts).toEqual([
      { hostId: "local-host", kind: "local" },
      { hostId: "remote-host", kind: "remote" },
    ]);
    fleet.dispose();
  });

  it("synthesizes the local host when the registry does not list it", async () => {
    const dir = await makeTempDir();
    const enrollmentFile = await writeEnrollment(dir, "local-host");
    const authSession = new DesktopAuthSession();
    authSession.set(signedInSnapshot("user-a", "token-1"));
    const identity = new FakeIdentitySource("user-a", 0);
    const host = new FakeHostLifecycle();
    host.identityEnrollmentFile = enrollmentFile;
    const fleet = buildFleetSource({
      identity,
      authSession,
      host,
      listRegisteredHosts: async () => ({
        kind: "ok",
        response: { hosts: [buildHostListItem("remote-host")] },
      }),
    });

    await fleet.refresh();

    expect(fleet.snapshot().hosts).toEqual([
      { hostId: "local-host", kind: "local" },
      { hostId: "remote-host", kind: "remote" },
    ]);
    fleet.dispose();
  });

  it("sorts entries by hostId so a server-side reordering is not a membership change", async () => {
    const dir = await makeTempDir();
    const enrollmentFile = await writeEnrollment(dir, "m-host");
    const authSession = new DesktopAuthSession();
    authSession.set(signedInSnapshot("user-a", "token-1"));
    const identity = new FakeIdentitySource("user-a", 0);
    const host = new FakeHostLifecycle();
    host.identityEnrollmentFile = enrollmentFile;
    const fleet = buildFleetSource({
      identity,
      authSession,
      host,
      listRegisteredHosts: async () => ({
        kind: "ok",
        response: {
          hosts: [
            buildHostListItem("z-host"),
            buildHostListItem("a-host"),
            buildHostListItem("m-host"),
          ],
        },
      }),
    });

    await fleet.refresh();

    expect(fleet.snapshot().hosts.map((entry) => entry.hostId)).toEqual([
      "a-host",
      "m-host",
      "z-host",
    ]);
    fleet.dispose();
  });

  it("stamps the identity generation at fetch START, so a late completion carries the OLD generation", async () => {
    const dir = await makeTempDir();
    const enrollmentFile = await writeEnrollment(dir, "local-host");
    const authSession = new DesktopAuthSession();
    authSession.set(signedInSnapshot("user-a", "token-1"));
    const identity = new FakeIdentitySource("user-a", 0);
    const host = new FakeHostLifecycle();
    host.identityEnrollmentFile = enrollmentFile;

    const registry = recordingRegistryFetch();
    const fleet = buildFleetSource({
      identity,
      authSession,
      host,
      listRegisteredHosts: registry.fetch,
    });

    const publishedGenerations: number[] = [];
    fleet.onChanged((snapshot) => {
      publishedGenerations.push(snapshot.identityGeneration);
    });

    const inFlight = fleet.refresh();
    // Wait for the FACT this case depends on - refresh #1 is past its
    // filesystem read and inside the fetch - so the identity change below
    // cannot race ahead of it and take call #0 for itself.
    await registry.started(0);
    // Identity moves on WHILE the first fetch is in flight.
    identity.set("user-b", 1);
    await registry.started(1);

    registry.calls[0]?.resolve({
      kind: "ok",
      response: { hosts: [buildHostListItem("local-host")] },
    });
    await inFlight;
    registry.calls[1]?.resolve({ kind: "ok", response: { hosts: [] } });
    await Promise.resolve();

    // The publish produced by the FIRST (stale) fetch must still carry
    // generation 0, whatever revision it lands at.
    expect(publishedGenerations).toContain(0);
    const staleIndex = publishedGenerations.lastIndexOf(0);
    expect(staleIndex).toBeGreaterThanOrEqual(0);
    fleet.dispose();
  });

  it("never lets a late account-A completion contaminate the port's own cache after a switch to account B", async () => {
    const dir = await makeTempDir();
    const enrollmentFile = join(dir, "enrollment.json");
    await writeFile(
      enrollmentFile,
      JSON.stringify({ hostId: "local-a" }),
      "utf8",
    );
    const authSession = new DesktopAuthSession();
    authSession.set(signedInSnapshot("user-a", "token-1"));
    const identity = new FakeIdentitySource("user-a", 0);
    const host = new FakeHostLifecycle();
    host.identityEnrollmentFile = enrollmentFile;

    const callDeferreds: Array<Deferred<HostListFetchResult>> = [];
    const fleet = buildFleetSource({
      identity,
      authSession,
      host,
      listRegisteredHosts: async () => {
        const call = deferred<HostListFetchResult>();
        callDeferreds.push(call);
        return call.promise;
      },
    });

    const snapshots: HostFleetSnapshot[] = [];
    fleet.onChanged((snapshot) => snapshots.push(snapshot));

    const inFlightA = fleet.refresh(); // call #1, captured generation 0.
    await flushIo();
    expect(callDeferreds).toHaveLength(1);

    // Switch to account B WHILE A's fetch is still in flight.
    identity.set("user-b", 1);
    expect(snapshots.at(-1)).toMatchObject({
      identityGeneration: 1,
      localHostId: null,
      hosts: [],
    });

    // B's own auto-triggered refresh (call #2) reaches listRegisteredHosts too.
    await flushIo();
    expect(callDeferreds).toHaveLength(2);

    // Resolve A's STALE fetch first.
    callDeferreds[0].resolve({
      kind: "ok",
      response: { hosts: [buildHostListItem("host-a")] },
    });
    await inFlightA;
    expect(snapshots.at(-1)).toMatchObject({ identityGeneration: 0 });

    // THEN complete B's own refresh with B's rows.
    callDeferreds[1].resolve({
      kind: "ok",
      response: { hosts: [buildHostListItem("host-b")] },
    });
    await flushIo();

    // A local-host republish afterwards - a DIFFERENT durable local id.
    await writeFile(
      enrollmentFile,
      JSON.stringify({ hostId: "local-b" }),
      "utf8",
    );
    host.emitChange();
    await flushIo();

    const finalSnapshot = snapshots.at(-1);
    expect(finalSnapshot?.identityGeneration).toBe(1);
    const finalHostIds = finalSnapshot?.hosts.map((entry) => entry.hostId);
    expect(finalHostIds).not.toContain("host-a");
    expect(finalHostIds).toContain("host-b");
    fleet.dispose();
  });

  it("does not adopt a late account-A completion into its own cache, even when it resolves AFTER account B's refresh", async () => {
    const dir = await makeTempDir();
    const enrollmentFile = join(dir, "enrollment.json");
    await writeFile(
      enrollmentFile,
      JSON.stringify({ hostId: "local-a" }),
      "utf8",
    );
    const authSession = new DesktopAuthSession();
    authSession.set(signedInSnapshot("user-a", "token-1"));
    const identity = new FakeIdentitySource("user-a", 0);
    const host = new FakeHostLifecycle();
    host.identityEnrollmentFile = enrollmentFile;

    const callDeferreds: Array<Deferred<HostListFetchResult>> = [];
    const fleet = buildFleetSource({
      identity,
      authSession,
      host,
      listRegisteredHosts: async () => {
        const call = deferred<HostListFetchResult>();
        callDeferreds.push(call);
        return call.promise;
      },
    });

    const snapshots: HostFleetSnapshot[] = [];
    fleet.onChanged((snapshot) => snapshots.push(snapshot));

    const inFlightA = fleet.refresh(); // call #1, captured generation 0.
    await flushIo();
    expect(callDeferreds).toHaveLength(1);

    // Switch to account B WHILE A's fetch is still in flight - triggers B's
    // own auto-refresh (call #2).
    identity.set("user-b", 1);
    await flushIo();
    expect(callDeferreds).toHaveLength(2);

    // Resolve B's fetch FIRST...
    callDeferreds[1].resolve({
      kind: "ok",
      response: { hosts: [buildHostListItem("host-b")] },
    });
    await flushIo();
    // B's own refresh reads the local id BEFORE the enrollment file is
    // rewritten below, so it still synthesizes "local-a" as local here - the
    // point of this assertion is only that host-b's row landed.
    expect(snapshots.at(-1)?.identityGeneration).toBe(1);
    expect(snapshots.at(-1)?.hosts).toContainEqual({
      hostId: "host-b",
      kind: "remote",
    });

    // ...THEN resolve A's now-doubly-stale fetch LAST.
    callDeferreds[0].resolve({
      kind: "ok",
      response: { hosts: [buildHostListItem("host-a")] },
    });
    await inFlightA;
    // Published verbatim, stamped with the generation it was FETCHED under -
    // this is what lets the engine itself reject it.
    expect(snapshots.at(-1)).toMatchObject({ identityGeneration: 0 });

    // Force a republish under the CURRENT generation with no new fetch: a
    // local-host change, no listRegisteredHosts call involved at all.
    await writeFile(
      enrollmentFile,
      JSON.stringify({ hostId: "local-b" }),
      "utf8",
    );
    host.emitChange();
    await flushIo();

    // The republish must carry B's cached membership, NOT the late A
    // completion that resolved after it. If the port's own cache had
    // adopted A's rows/localHostId, this republish - stamped honestly with
    // the CURRENT generation (1) - would carry account A's rows straight
    // past the engine's identityGeneration guard.
    const finalSnapshot = snapshots.at(-1);
    expect(finalSnapshot?.identityGeneration).toBe(1);
    const finalHostIds = finalSnapshot?.hosts.map((entry) => entry.hostId);
    expect(finalHostIds).not.toContain("host-a");
    expect(finalHostIds).toContain("host-b");
    fleet.dispose();
  });

  it("publishes an EMPTY fleet for the incoming generation immediately on an identity change", () => {
    const authSession = new DesktopAuthSession();
    authSession.set(signedInSnapshot("user-a", "token-1"));
    const identity = new FakeIdentitySource("user-a", 0);
    const host = new FakeHostLifecycle();
    const never = deferred<HostListFetchResult>();
    const fleet = buildFleetSource({
      identity,
      authSession,
      host,
      listRegisteredHosts: async () => never.promise,
    });

    const snapshots: HostFleetSnapshot[] = [];
    fleet.onChanged((snapshot) => snapshots.push(snapshot));

    identity.set("user-b", 1);

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({ identityGeneration: 1, hosts: [] });
    fleet.dispose();
  });

  it("a failed fetch on a COLD source still publishes this machine's local host - usability does not wait on the cloud", async () => {
    // The old pin here said "publishes nothing", and that absolutism was the
    // regression: at cold boot the source's default is an EMPTY fleet, so a
    // flaky registry read left `effectiveHostId` null - "No host is
    // available" over a machine with a durable, dialable local host - until
    // the 60s poll or a host-change event happened to rescue it. The local
    // id was already read from disk before the fetch; a cloud failure keeps
    // the rows unknown, not the machine.
    const dir = await makeTempDir();
    const enrollmentFile = await writeEnrollment(dir, "local-host");
    const authSession = new DesktopAuthSession();
    authSession.set(signedInSnapshot("user-a", "token-1"));
    const identity = new FakeIdentitySource("user-a", 0);
    const host = new FakeHostLifecycle();
    host.identityEnrollmentFile = enrollmentFile;

    const failures: Array<() => Promise<HostListFetchResult>> = [
      async () => ({ kind: "network-error" }),
      async () => ({ kind: "unauthorized" }),
      // The THROWN arm, distinct from a non-ok result: `refresh` contains it,
      // and the containment must not swallow the local adoption either.
      async () => {
        throw new Error("socket hang up");
      },
    ];
    for (const listRegisteredHosts of failures) {
      const fleet = buildFleetSource({
        identity,
        authSession,
        host,
        listRegisteredHosts,
      });
      const snapshots: HostFleetSnapshot[] = [];
      fleet.onChanged((snapshot) => snapshots.push(snapshot));

      await fleet.refresh();

      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]).toMatchObject({
        localHostId: "local-host",
        hosts: [{ hostId: "local-host", kind: "local" }],
      });
      fleet.dispose();
    }
  });

  it("a failed fetch AFTER adopted membership keeps the rows and publishes nothing new - known membership is not clobbered", async () => {
    // The half of the old pin that was always right, now stated on the
    // fixture that actually exercises it: membership has to exist before a
    // failure can be accused of clobbering it. The failed refresh re-adopts
    // the same local id (a no-op by the value guard) and leaves the rows
    // alone, so no snapshot is published at all.
    const dir = await makeTempDir();
    const enrollmentFile = await writeEnrollment(dir, "local-host");
    const authSession = new DesktopAuthSession();
    authSession.set(signedInSnapshot("user-a", "token-1"));
    const identity = new FakeIdentitySource("user-a", 0);
    const host = new FakeHostLifecycle();
    host.identityEnrollmentFile = enrollmentFile;

    let fail = false;
    const fleet = buildFleetSource({
      identity,
      authSession,
      host,
      listRegisteredHosts: async () => {
        if (fail) return { kind: "network-error" };
        return {
          kind: "ok",
          response: { hosts: [buildHostListItem("remote-1")] },
        };
      },
    });
    const snapshots: HostFleetSnapshot[] = [];
    fleet.onChanged((snapshot) => snapshots.push(snapshot));

    await fleet.refresh();
    expect(snapshots).toHaveLength(1);

    fail = true;
    await fleet.refresh();

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      localHostId: "local-host",
      hosts: [
        { hostId: "local-host", kind: "local" },
        { hostId: "remote-1", kind: "remote" },
      ],
    });
    fleet.dispose();
  });

  it("declines a superseded same-identity completion - an older response landing last must not resurrect removed rows", async () => {
    const dir = await makeTempDir();
    const enrollmentFile = await writeEnrollment(dir, "local-host");
    const authSession = new DesktopAuthSession();
    authSession.set(signedInSnapshot("user-a", "token-1"));
    const identity = new FakeIdentitySource("user-a", 0);
    const host = new FakeHostLifecycle();
    host.identityEnrollmentFile = enrollmentFile;

    const registry = recordingRegistryFetch();
    const fleet = buildFleetSource({
      identity,
      authSession,
      host,
      listRegisteredHosts: registry.fetch,
    });

    // Two overlapping refreshes under ONE identity - the 60s poll racing a
    // deregistration's fire-and-forget refresh. The generation stamp cannot
    // order these (same generation); only the request sequence can.
    const first = fleet.refresh();
    await registry.started(0);
    const second = fleet.refresh();
    await registry.started(1);

    // The NEWER response (post-deregister: the host is gone) completes first.
    registry.calls[1]?.resolve({ kind: "ok", response: { hosts: [] } });
    await second;
    // The OLDER response (still carrying the deregistered host) lands last.
    registry.calls[0]?.resolve({
      kind: "ok",
      response: { hosts: [buildHostListItem("deregistered-host")] },
    });
    await first;

    // Completion order must not become fleet order: the older rows are
    // declined, and the deregistered host stays out of the authority. The
    // synthesized LOCAL host is fleet membership of its own and stays.
    const hostIds = fleet.snapshot().hosts.map((row) => row.hostId);
    expect(hostIds).not.toContain("deregistered-host");
    expect(hostIds).toContain("local-host");
  });

  it("publishes an empty fleet with localHostId: null when signed out", async () => {
    const authSession = new DesktopAuthSession();
    const identity = new FakeIdentitySource(null, 0);
    const host = new FakeHostLifecycle();
    const fleet = buildFleetSource({
      identity,
      authSession,
      host,
      listRegisteredHosts: async () => {
        throw new Error("must not be called when signed out");
      },
    });

    await fleet.refresh();

    expect(fleet.snapshot()).toMatchObject({ localHostId: null, hosts: [] });
    fleet.dispose();
  });

  it("keeps revision process-lifetime monotonic across every publish, including identity changes", async () => {
    const dir = await makeTempDir();
    const enrollmentFile = await writeEnrollment(dir, "local-host");
    const authSession = new DesktopAuthSession();
    authSession.set(signedInSnapshot("user-a", "token-1"));
    const identity = new FakeIdentitySource("user-a", 0);
    const host = new FakeHostLifecycle();
    host.identityEnrollmentFile = enrollmentFile;
    const fleet = buildFleetSource({
      identity,
      authSession,
      host,
      listRegisteredHosts: async () => ({
        kind: "ok",
        response: { hosts: [buildHostListItem("local-host")] },
      }),
    });

    const revisions: number[] = [];
    fleet.onChanged((snapshot) => revisions.push(snapshot.revision));

    await fleet.refresh();
    identity.set("user-b", 1); // publishes empty immediately, then refreshes
    await fleet.refresh();

    for (let i = 1; i < revisions.length; i += 1) {
      expect(revisions[i]).toBeGreaterThan(revisions[i - 1]);
    }
    expect(revisions.length).toBeGreaterThanOrEqual(3);
    fleet.dispose();
  });

  it("captures the generation at read START: a late enrollment read for a RETIRED account is never adopted under the CURRENT generation (A1)", async () => {
    const dir = await makeTempDir();
    const enrollmentFile = join(dir, "enrollment.json");
    await writeFile(
      enrollmentFile,
      JSON.stringify({ hostId: "local-a" }),
      "utf8",
    );
    const authSession = new DesktopAuthSession();
    // Signed out throughout: this isolates `refreshLocalIdentity` from
    // `refresh()`'s own auto-triggered fetch (which would need a bearer
    // token to reach `listRegisteredHosts` at all), so the only thing that
    // can publish a snapshot here is the local-identity re-read this test is
    // pinning.
    const identity = new FakeIdentitySource(null, 0);
    const host = new FakeHostLifecycle();
    host.identityEnrollmentFile = enrollmentFile;
    const fleet = buildFleetSource({
      identity,
      authSession,
      host,
      listRegisteredHosts: async () => {
        throw new Error("must not be called - signed out throughout");
      },
    });

    const snapshots: HostFleetSnapshot[] = [];
    fleet.onChanged((snapshot) => snapshots.push(snapshot));

    // Fire the `host` change: `refreshLocalIdentity` captures generation 0
    // and starts its (real, libuv-backed) enrollment read. `fs.readFile`
    // cannot resolve before this synchronous block finishes, so switching
    // the identity here lands strictly BEFORE the read completes - the
    // exact race the fix closes.
    host.emitChange();
    identity.set("user-b", 1);

    // The identity switch publishes the generation-1 shape synchronously
    // (the empty-fleet publish plus the signed-out `refresh()` it triggers,
    // both before the stale read has any chance to land).
    expect(snapshots.length).toBeGreaterThanOrEqual(1);
    for (const snapshot of snapshots) {
      expect(snapshot).toMatchObject({
        identityGeneration: 1,
        localHostId: null,
        hosts: [],
      });
    }

    // Let the stale enrollment read (account A, generation 0) resolve.
    await flushIo();

    // No snapshot carrying A's local host id was published under
    // identityGeneration: 1 - the stale read must not be stamped with
    // whatever generation happens to be current when it completes.
    const contaminatedUnderCurrentGeneration = snapshots.some(
      (snapshot) =>
        snapshot.identityGeneration === 1 &&
        (snapshot.localHostId === "local-a" ||
          snapshot.hosts.some((entry) => entry.hostId === "local-a")),
    );
    expect(contaminatedUnderCurrentGeneration).toBe(false);

    // The port's latest snapshot still has the generation-1 shape the
    // identity change published: no A rows, no A local host id.
    expect(fleet.snapshot()).toMatchObject({
      identityGeneration: 1,
      localHostId: null,
      hosts: [],
    });

    // ANTI-VACUITY ANCHOR, in two halves. The negative assertions above are
    // only meaningful if the enrollment read actually had time to complete
    // inside `flushIo`; a read still in flight would satisfy them for the
    // wrong reason. But a signed-out read publishes NOTHING (eligibility, not
    // just staleness, gates it - a durable local id must not repopulate a
    // fleet `refresh` has declared empty), so "nothing was published" cannot
    // by itself prove the pipeline ran.
    //
    // Half 1: SIGN IN, then drive a local-host change. The read must land and
    // publish the id - this is what proves the pipeline completes inside the
    // flush window, so the silence above was a decision and not a delay.
    authSession.set(signedInSnapshot("user-b", "token-b"));
    host.emitChange();
    await flushIo();
    expect(fleet.snapshot()).toMatchObject({
      identityGeneration: 1,
      localHostId: "local-a",
    });

    // Half 2: SIGN OUT again and drive another change. The id is RETRACTED,
    // not retained - the same rule `refresh`'s signed-out branch applies.
    authSession.set({ status: "signed-out", token: null, profile: null });
    host.emitChange();
    await flushIo();
    expect(fleet.snapshot()).toMatchObject({
      identityGeneration: 1,
      localHostId: null,
      hosts: [],
    });

    fleet.dispose();
  });

  it("keeps a NEWER local identity when an older refresh completes after it", async () => {
    // The two writers of `localHostId` race: `refresh()` reads the id BEFORE
    // its registry fetch and adopts it AFTER, so a local-host change that
    // lands during that fetch was published and then overwritten by the id the
    // refresh had already read - the authority then called the stale host
    // local and this machine remote until the next event or the 60s poll.
    const dir = await makeTempDir();
    const enrollmentFile = join(dir, "enrollment.json");
    await writeFile(
      enrollmentFile,
      JSON.stringify({ hostId: "local-host-1" }),
      "utf8",
    );
    const authSession = new DesktopAuthSession();
    authSession.set(signedInSnapshot("user-a", "token-1"));
    const identity = new FakeIdentitySource("user-a", 0);
    const host = new FakeHostLifecycle();
    host.identityEnrollmentFile = enrollmentFile;

    // Initialized with a real no-op rather than `null`: a `(() => void) | null`
    // is narrowed to `never` at the call below, because the only assignment
    // control flow can see is the initializer.
    let releaseFetch = (): void => undefined;
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = () => {
        resolve();
      };
    });
    const fleet = buildFleetSource({
      identity,
      authSession,
      host,
      listRegisteredHosts: async () => {
        await fetchGate;
        return { kind: "ok", response: { hosts: [] } };
      },
    });

    // In flight, having already read `local-host-1`.
    const refreshing = fleet.refresh();
    await flushIo();

    // The machine re-enrolls while that fetch is outstanding.
    await writeFile(
      enrollmentFile,
      JSON.stringify({ hostId: "local-host-2" }),
      "utf8",
    );
    host.emitChange();
    await flushIo();
    expect(fleet.snapshot().localHostId).toBe("local-host-2");

    releaseFetch();
    await refreshing;
    await flushIo();

    // The older refresh still adopts its ROWS; only its stale id is declined.
    expect(fleet.snapshot().localHostId).toBe("local-host-2");
    fleet.dispose();
  });

  it("re-resolves the local identity and republishes on a local-host change; a no-op id change publishes nothing", async () => {
    const dir = await makeTempDir();
    const enrollmentFile = join(dir, "enrollment.json");
    await writeFile(
      enrollmentFile,
      JSON.stringify({ hostId: "local-host-1" }),
      "utf8",
    );
    const authSession = new DesktopAuthSession();
    authSession.set(signedInSnapshot("user-a", "token-1"));
    const identity = new FakeIdentitySource("user-a", 0);
    const host = new FakeHostLifecycle();
    host.identityEnrollmentFile = enrollmentFile;
    const fleet = buildFleetSource({
      identity,
      authSession,
      host,
      listRegisteredHosts: async () => ({
        kind: "ok",
        response: { hosts: [] },
      }),
    });
    await fleet.refresh();

    const snapshots: HostFleetSnapshot[] = [];
    fleet.onChanged((snapshot) => snapshots.push(snapshot));

    // No-op: same id on disk, `host` fires "change" anyway.
    host.emitChange();
    await flushIo();
    expect(snapshots).toEqual([]);

    // Real change: rewrite the enrollment file, then fire the local-host
    // change signal again.
    await writeFile(
      enrollmentFile,
      JSON.stringify({ hostId: "local-host-2" }),
      "utf8",
    );
    host.emitChange();
    await flushIo();

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].localHostId).toBe("local-host-2");
    fleet.dispose();
  });
});

// ---------------------------------------------------------------------------
// DesktopHostFleetSource / publishRegistryResponse (redesign P4.1/F22)
// ---------------------------------------------------------------------------

describe("DesktopHostFleetSource publishRegistryResponse", () => {
  it("publishes ONCE per successful refresh, carrying the FULL response rows and the identityKey captured at fetch start", async () => {
    const dir = await makeTempDir();
    const enrollmentFile = await writeEnrollment(dir, "local-host");
    const authSession = new DesktopAuthSession();
    authSession.set(signedInSnapshot("user-a", "token-1"));
    const identity = new FakeIdentitySource("user-a", 0);
    const host = new FakeHostLifecycle();
    host.identityEnrollmentFile = enrollmentFile;
    const rows = [
      buildHostListItem("local-host"),
      buildHostListItem("remote-host"),
    ];
    const { fleet, published } = buildFleetSourceWithPublisher({
      identity,
      authSession,
      host,
      listRegisteredHosts: async () => ({
        kind: "ok",
        response: { hosts: rows },
      }),
    });

    await fleet.refresh();

    expect(published).toHaveLength(1);
    expect(published[0]).toEqual({
      identityKey: "user-a",
      response: { hosts: rows },
    });
    // The FULL rows, not just ids: every field `buildHostListItem` sets
    // (the status DTO, publicKey, createdAt, ...) must survive intact - this
    // is what lets every window skip its own fetch.
    expect(published[0]?.response.hosts[0]).toMatchObject({
      hostId: "local-host",
      publicKey: "pub-key",
      status: expect.objectContaining({ connectivity: "connectable" }),
    });
    fleet.dispose();
  });

  /**
   * ONE fetch per refresh - the arithmetic the whole move rests on.
   *
   * Added after a probe: doubling the fetch inside `refreshOrThrow` DID turn
   * this suite red, but for the wrong reason. The arm it broke drives
   * `listRegisteredHosts` with a CALL-ORDERED fake (`calls.length === 1 ? … : …`),
   * so an extra call shifts which promise each caller gets and the failure is
   * the fixture's sequencing, not a statement about how many requests the app
   * makes. Nothing asserted the count itself.
   *
   * That distinction matters here more than usual: "N windows now produce ONE
   * poll" is this change's entire claim, and a claim whose only guard is a
   * fixture's call ordering would survive any refactor that kept the ordering
   * and doubled the requests.
   */
  it("issues exactly ONE registry request per refresh - the claim the move rests on", async () => {
    const dir = await makeTempDir();
    const enrollmentFile = await writeEnrollment(dir, "local-host");
    const authSession = new DesktopAuthSession();
    authSession.set(signedInSnapshot("user-a", "token-1"));
    const identity = new FakeIdentitySource("user-a", 0);
    const host = new FakeHostLifecycle();
    host.identityEnrollmentFile = enrollmentFile;
    let fetchCount = 0;
    const { fleet } = buildFleetSourceWithPublisher({
      identity,
      authSession,
      host,
      listRegisteredHosts: async () => {
        fetchCount += 1;
        return { kind: "ok", response: { hosts: [] } };
      },
    });

    await fleet.refresh();
    expect(fetchCount).toBe(1);

    // ...and a second refresh is a second request, not a cached answer - the
    // count has to track calls, or "exactly one" above would also be satisfied
    // by a source that never fetches again.
    await fleet.refresh();
    expect(fetchCount).toBe(2);

    fleet.dispose();
  });

  it("publishes NOTHING when the fetch returns a non-ok result (network-error, unauthorized)", async () => {
    const dir = await makeTempDir();
    const enrollmentFile = await writeEnrollment(dir, "local-host");
    const authSession = new DesktopAuthSession();
    authSession.set(signedInSnapshot("user-a", "token-1"));
    const identity = new FakeIdentitySource("user-a", 0);
    const host = new FakeHostLifecycle();
    host.identityEnrollmentFile = enrollmentFile;

    for (const kind of ["network-error", "unauthorized"] as const) {
      const { fleet, published } = buildFleetSourceWithPublisher({
        identity,
        authSession,
        host,
        listRegisteredHosts: async () => ({ kind }),
      });

      await fleet.refresh();

      expect(published).toEqual([]);
      fleet.dispose();
    }
  });

  it("publishes NOTHING on a signed-out refresh (no bearer)", async () => {
    const authSession = new DesktopAuthSession();
    const identity = new FakeIdentitySource(null, 0);
    const host = new FakeHostLifecycle();
    const { fleet, published } = buildFleetSourceWithPublisher({
      identity,
      authSession,
      host,
      listRegisteredHosts: async () => {
        throw new Error("must not be called when signed out");
      },
    });

    await fleet.refresh();

    expect(published).toEqual([]);
    fleet.dispose();
  });

  it("stamps the push with the identityKey captured at fetch START - a late completion still publishes, under the OLD identity", async () => {
    const dir = await makeTempDir();
    const enrollmentFile = await writeEnrollment(dir, "local-host");
    const authSession = new DesktopAuthSession();
    authSession.set(signedInSnapshot("user-a", "token-1"));
    const identity = new FakeIdentitySource("user-a", 0);
    const host = new FakeHostLifecycle();
    host.identityEnrollmentFile = enrollmentFile;

    const registry = recordingRegistryFetch();
    const { fleet, published } = buildFleetSourceWithPublisher({
      identity,
      authSession,
      host,
      listRegisteredHosts: registry.fetch,
    });

    const inFlight = fleet.refresh();
    // Wait for the FACT this case depends on - refresh #1 is past its
    // filesystem read and inside the fetch - rather than assuming the
    // refreshes reach the registry in the order the test started them.
    await registry.started(0);
    // Identity moves on WHILE the first fetch is in flight - this fires the
    // port's own identity-change subscription, which starts a SECOND fetch
    // (account B's own refresh) immediately.
    identity.set("user-b", 1);
    await registry.started(1);

    registry.calls[0]?.resolve({
      kind: "ok",
      response: { hosts: [buildHostListItem("local-host")] },
    });
    await inFlight;
    registry.calls[1]?.resolve({ kind: "ok", response: { hosts: [] } });
    await Promise.resolve();

    // The FIRST (stale) fetch's completion is still published - a late
    // completion is published so the renderer can drop it by its own stamp -
    // but stamped with the identity it was FETCHED under, "user-a", never
    // the "user-b" that was current when it happened to resolve.
    const stalePush = published.find((push) => push.identityKey === "user-a");
    expect(stalePush).toBeDefined();
    expect(stalePush?.response.hosts.map((row) => row.hostId)).toEqual([
      "local-host",
    ]);
    fleet.dispose();
  });

  it("keeps the authority snapshot ids-only even though the publish carries the full status DTO (invariant 5)", async () => {
    const dir = await makeTempDir();
    const enrollmentFile = await writeEnrollment(dir, "local-host");
    const authSession = new DesktopAuthSession();
    authSession.set(signedInSnapshot("user-a", "token-1"));
    const identity = new FakeIdentitySource("user-a", 0);
    const host = new FakeHostLifecycle();
    host.identityEnrollmentFile = enrollmentFile;
    const { fleet, published } = buildFleetSourceWithPublisher({
      identity,
      authSession,
      host,
      listRegisteredHosts: async () => ({
        kind: "ok",
        response: { hosts: [buildHostListItem("local-host")] },
      }),
    });

    await fleet.refresh();

    // The push carries the full row - status DTO and all.
    expect(published[0]?.response.hosts[0]).toHaveProperty("status");
    // The snapshot the authority itself reads carries ONLY hostId/kind -
    // unchanged by this port gaining a second consumer of the same fetch.
    expect(fleet.snapshot().hosts).toHaveLength(1);
    for (const entry of fleet.snapshot().hosts) {
      expect(Object.keys(entry).sort()).toEqual(["hostId", "kind"]);
    }
    fleet.dispose();
  });
});

// ---------------------------------------------------------------------------
// DesktopLocalHostOutageSignal
// ---------------------------------------------------------------------------

function buildControllerStatus(
  mutation: HostControllerStatus["mutation"],
): HostControllerStatus {
  return {
    download: null,
    mutation,
    installedVersion: "1.0.0",
    latestVersion: "1.0.0",
    stagedVersion: null,
    installedRuntimeVersion: "1.0.0",
    runningRuntimeVersion: "1.0.0",
    updateReady: false,
    activation: "activated",
    reachable: true,
    removedByUser: false,
    checkedAt: "2026-01-01T00:00:00.000Z",
  };
}

const activeMutation: NonNullable<HostControllerStatus["mutation"]> = {
  kind: "ensure",
  progress: null,
  startedAt: "2026-01-01T00:00:00.000Z",
};

describe("DesktopLocalHostOutageSignal", () => {
  it("is true exactly while a broadcast status carries a non-null mutation lane, edge-triggered", async () => {
    let readStatusResolve: (status: HostControllerStatus) => void = () =>
      undefined;
    const readStatus = () =>
      new Promise<HostControllerStatus>((resolve) => {
        readStatusResolve = resolve;
      });
    const tickListeners = new Set<(status: HostControllerStatus) => void>();
    const subscribe = (listener: (status: HostControllerStatus) => void) => {
      tickListeners.add(listener);
      return () => tickListeners.delete(listener);
    };

    const signal = new DesktopLocalHostOutageSignal({
      subscribe,
      readStatus,
      log: silentLog,
    });
    // Settle the initial read as idle so it does not interfere.
    readStatusResolve(buildControllerStatus(null));
    await Promise.resolve();

    const seen: boolean[] = [];
    signal.onChanged((next) => seen.push(next));

    expect(signal.inExpectedOutage()).toBe(false);

    for (const listener of tickListeners)
      listener(buildControllerStatus(activeMutation));
    expect(signal.inExpectedOutage()).toBe(true);
    expect(seen).toEqual([true]);

    // Repeated identical ticks: no duplicate notifications.
    for (const listener of tickListeners)
      listener(buildControllerStatus(activeMutation));
    expect(seen).toEqual([true]);

    for (const listener of tickListeners) listener(buildControllerStatus(null));
    expect(signal.inExpectedOutage()).toBe(false);
    expect(seen).toEqual([true, false]);

    signal.dispose();
  });

  it("leaves inExpectedOutage() false when the initial read rejects, and a later tick still corrects it", async () => {
    const readStatus = () => Promise.reject(new Error("initial read failed"));
    const tickListeners = new Set<(status: HostControllerStatus) => void>();
    const subscribe = (listener: (status: HostControllerStatus) => void) => {
      tickListeners.add(listener);
      return () => tickListeners.delete(listener);
    };

    const signal = new DesktopLocalHostOutageSignal({
      subscribe,
      readStatus,
      log: silentLog,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(signal.inExpectedOutage()).toBe(false);

    for (const listener of tickListeners)
      listener(buildControllerStatus(activeMutation));
    expect(signal.inExpectedOutage()).toBe(true);

    signal.dispose();
  });

  it("ignores a STALE initial read that answers AFTER a live broadcast tick has already landed (A2)", async () => {
    const readStatus = deferred<HostControllerStatus>();
    const tickListeners = new Set<(status: HostControllerStatus) => void>();
    const subscribe = (listener: (status: HostControllerStatus) => void) => {
      tickListeners.add(listener);
      return () => tickListeners.delete(listener);
    };

    const signal = new DesktopLocalHostOutageSignal({
      subscribe,
      readStatus: () => readStatus.promise,
      log: silentLog,
    });

    const seen: boolean[] = [];
    signal.onChanged((next) => seen.push(next));

    // A live broadcast tick lands first, carrying a non-null mutation lane.
    for (const listener of tickListeners) {
      listener(buildControllerStatus(activeMutation));
    }
    expect(signal.inExpectedOutage()).toBe(true);
    expect(seen).toEqual([true]);

    // THEN the initial `readStatus()` resolves - answering `mutation: null`,
    // i.e. stale by the time it lands.
    readStatus.resolve(buildControllerStatus(null));
    await Promise.resolve();
    await Promise.resolve();

    // The exemption for a genuinely-under-way outage must survive: the
    // older read must not clear it, and no onChanged(false) is delivered.
    expect(signal.inExpectedOutage()).toBe(true);
    expect(seen).toEqual([true]);

    signal.dispose();
  });

  it("with no broadcast at all, the initial read still establishes the value (A2 mirror)", async () => {
    const readStatus = deferred<HostControllerStatus>();
    const tickListeners = new Set<(status: HostControllerStatus) => void>();
    const subscribe = (listener: (status: HostControllerStatus) => void) => {
      tickListeners.add(listener);
      return () => tickListeners.delete(listener);
    };

    const signal = new DesktopLocalHostOutageSignal({
      subscribe,
      readStatus: () => readStatus.promise,
      log: silentLog,
    });

    const seen: boolean[] = [];
    signal.onChanged((next) => seen.push(next));

    expect(signal.inExpectedOutage()).toBe(false);
    expect(tickListeners.size).toBe(1); // subscribed, but never ticked.

    readStatus.resolve(buildControllerStatus(activeMutation));
    await Promise.resolve();
    await Promise.resolve();

    expect(signal.inExpectedOutage()).toBe(true);
    expect(seen).toEqual([true]);

    signal.dispose();
  });
});

// ---------------------------------------------------------------------------
// createDesktopLocalHostEnsurePort
// ---------------------------------------------------------------------------

class FakeHostController implements IpcHostController {
  outcome: MutationOutcome<ConvergeReadyOk> = {
    kind: "ok",
    value: { running: true, version: "1.0.0" },
  };

  readonly lifecycleAdmissionBlock: LifecycleAdmissionBlock | null = null;
  async getStatus(): Promise<HostControllerStatus> {
    return buildControllerStatus(null);
  }
  async convergeReady(
    _force: boolean,
  ): Promise<MutationOutcome<ConvergeReadyOk>> {
    return this.outcome;
  }
  async stageLatest(): Promise<void> {}
  async applyStaged(
    _trigger: ApplyStagedTrigger,
    _force: boolean,
  ): Promise<MutationOutcome<ApplyStagedOk>> {
    return {
      kind: "ok",
      value: { appliedVersion: "1.0.0", runningActivated: true },
    };
  }
  async activateInstalled(
    _force: boolean,
  ): Promise<MutationOutcome<ActivateInstalledOk>> {
    return { kind: "ok", value: { activated: true } };
  }
  async installVersion(
    pin: string,
    _force: boolean,
  ): Promise<MutationOutcome<InstallVersionOk>> {
    return {
      kind: "ok",
      value: { installedVersion: pin, runningActivated: true },
    };
  }
  async registerService(): Promise<MutationOutcome<ServiceRegistrationOk>> {
    return { kind: "ok", value: { registered: true } };
  }
  async deregisterService(): Promise<MutationOutcome<ServiceRegistrationOk>> {
    return { kind: "ok", value: { registered: false } };
  }
  async respawn(): Promise<MutationOutcome<ActivateInstalledOk>> {
    return { kind: "ok", value: { activated: true } };
  }
  async recoverIfDown(): Promise<
    MutationOutcome<ActivateInstalledOk> | { readonly kind: "suppressed" }
  > {
    return { kind: "suppressed" };
  }
  async freePortAndRestart(
    _pid: number | null,
    _port: number | null,
  ): Promise<MutationOutcome<ActivateInstalledOk>> {
    return { kind: "ok", value: { activated: true } };
  }
  async uninstallHost(_all: boolean): Promise<MutationOutcome<UninstallOk>> {
    return {
      kind: "ok",
      value: { removedInstallDir: true, deregisteredService: true },
    };
  }
  async removeTraycer(): Promise<MutationOutcome<RemoveTraycerOk>> {
    return {
      kind: "ok",
      value: {
        removedHost: true,
        deregisteredService: true,
        removedLoginItem: false,
      },
    };
  }
  isPendingRevisionRefreshQuarantined(): boolean {
    return false;
  }
  onMutationProgress(
    _listener: (progress: MutationProgress) => void,
  ): () => void {
    return () => undefined;
  }
}

describe("createDesktopLocalHostEnsurePort", () => {
  it("maps an ok outcome to {ok: true}", async () => {
    const controller = new FakeHostController();
    controller.outcome = {
      kind: "ok",
      value: { running: true, version: "1.0.0" },
    };
    const port = createDesktopLocalHostEnsurePort(controller);

    await expect(port.ensureReady()).resolves.toEqual({ ok: true });
  });

  it("refuses to call a REMOVED host alive, even though its converge answers ok", async () => {
    const controller = new FakeHostController();
    const port = createDesktopLocalHostEnsurePort(controller);
    // The exact short-circuit `HostController.convergeReady` returns while the
    // removal sentinel stands: `ok`, because nothing failed - and `running:
    // false`, because by consent nothing ran either. The engine reads a bare
    // `ok` as FIRSTHAND proof of life (`onHostProvedAlive` clears the refusal
    // streak and makes the lease usable), so mapping this one to `{ok: true}`
    // handed failover a host that is not installed, and re-cleared that streak
    // every pacing hold. Now it is a plain failure - and NOT deferred, because
    // nothing here changes on its own until the user reinstalls.
    controller.outcome = {
      kind: "ok",
      value: { running: false, version: null },
    };
    await expect(port.ensureReady()).resolves.toEqual({
      ok: false,
      reason: "removed-by-user",
      deferred: false,
    });
  });

  it("does NOT treat a busy refusal as proof of life - E_HOST_BUSY is a fail-safe", async () => {
    const controller = new FakeHostController();
    const port = createDesktopLocalHostEnsurePort(controller);
    // The tempting reading is "a host that is up with active work", and an
    // earlier revision of this port resolved `{ok: true}` on it to spare a
    // non-target local host one CLI spawn per pacing hold. `assertHostNotBusy`
    // says otherwise in its own words: it raises `E_HOST_BUSY` when a live
    // PID's idle state CANNOT BE DETERMINED - `/activity` timed out, refused,
    // answered malformed, or 404'd - exactly as it does when the host reports
    // real work. A WEDGED host is the first case, so `{ok: true}` handed
    // `onHostProvedAlive` a host that cannot serve: refusal evidence cleared,
    // lease usable, failover free to choose it, and each later ensure clearing
    // the refusals its failed dials had just rebuilt.
    controller.outcome = {
      kind: "busy",
      continuation: "retry-with-force",
      message: "busy",
    };
    await expect(port.ensureReady()).resolves.toEqual({
      ok: false,
      reason: "busy",
      deferred: true,
    });
  });

  it("maps failed/deferred outcomes to {ok: false, reason: <kind>}, with only failed non-deferred", async () => {
    const controller = new FakeHostController();
    const port = createDesktopLocalHostEnsurePort(controller);

    // `failed` actually ran and concluded - the one arm allowed to arm the
    // engine's dead-lease cooldown.
    controller.outcome = { kind: "failed", message: "boom" };
    await expect(port.ensureReady()).resolves.toEqual({
      ok: false,
      reason: "failed",
      deferred: false,
    });

    // `deferred` is the lane/lock being busy: nothing ran, nothing learned.
    controller.outcome = { kind: "deferred", message: "later" };
    await expect(port.ensureReady()).resolves.toEqual({
      ok: false,
      reason: "deferred",
      deferred: true,
    });
  });
});
