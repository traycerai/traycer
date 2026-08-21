import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DefaultRequestContextProvider } from "@traycer-clients/shared/auth/request-context-provider";
import { createAuthenticatedUserFixture } from "@traycer-clients/shared/test-fixtures/authenticated-user";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { mockRemoteHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import type {
  LocalHostSnapshot,
  RegisteredHostsChange,
} from "@traycer-clients/shared/platform/runner-host";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import {
  hostListItemToDirectoryEntry,
  isRemoteHostDirectoryEntry,
  RELAY_FUSE_MAX_ATTACH_MS,
  type RemoteHostFetchOutcome,
  type RemoteHostFetcher,
} from "@traycer-clients/shared/host-client/remote-fetcher";
import {
  HostDirectoryService,
  type HostDirectoryServiceOptions,
} from "@/lib/host/host-directory-service";
import { lastLocalHostIdKey } from "@/lib/persist";
import { useSettingsHostScopeStore } from "@/stores/settings/settings-host-scope-store";

const PLAN_ALLOWS_REMOTE = true;

// Matches the production constant of the same name in `host-directory-service.ts`
// — the app's ONE background cadence for `GET /api/v3/hosts`, moved from 15s to
// 60s to actually match the Settings observer's poll (see that file's comment).
const HOST_DIRECTORY_REFRESH_POLL_MS = 60_000;
const LAST_LOCAL_HOST_ID_STORAGE_KEY = lastLocalHostIdKey();

const localSnapshot: LocalHostSnapshot = {
  hostId: "desktop-pid-123",
  websocketUrl: "ws://127.0.0.1:4917/rpc",
  version: "1.2.3",
  pid: 4242,
  systemHostName: "hardiks-macbook",
  displayName: "hardiks-macbook",
  availability: "available",
};

const rememberedRemoteHostEntry: HostDirectoryEntry = {
  hostId: "remembered-remote-host",
  label: "Remembered Remote",
  kind: "remote",
  websocketUrl: "wss://remembered-remote.traycer.invalid/rpc",
  version: "0.0.0-mock",
  transportDialability: "dialable",
};

const secondRemoteHostEntry: HostDirectoryEntry = {
  hostId: "second-remote-host",
  label: "Second Remote",
  kind: "remote",
  websocketUrl: "wss://second-remote.traycer.invalid/rpc",
  version: "0.0.0-mock",
  transportDialability: "dialable",
};

function makeHost(localHost: LocalHostSnapshot | null): MockRunnerHost {
  return new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "http://localhost:5005",
    localHost,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
}

/**
 * `MockRunnerHost.onRegisteredHostsChange` always answers `null` (it models
 * no shell registry cadence - see the mock's own doc comment), which is
 * exactly right for every OTHER test in this file but wrong for the P4.1/F22
 * push-cadence arms below, which need to drive a real subscription. The
 * override matches how other tests in this codebase substitute a single
 * bridge method on an otherwise-real double (e.g.
 * `desktop-runner-host.test.ts`'s `fake.bridge.listUserSessions = ...`)
 * rather than hand-rolling a whole second `IRunnerHost`.
 */
function makeHostWithRegistryPush(localHost: LocalHostSnapshot | null): {
  readonly host: MockRunnerHost;
  readonly push: (change: RegisteredHostsChange) => void;
  readonly disposeCount: () => number;
} {
  const host = makeHost(localHost);
  const handlers = new Set<(push: RegisteredHostsChange) => void>();
  let disposeCalls = 0;
  host.onRegisteredHostsChange = (
    handler: (push: RegisteredHostsChange) => void,
  ): { dispose: () => void } => {
    handlers.add(handler);
    return {
      dispose: () => {
        handlers.delete(handler);
        disposeCalls += 1;
      },
    };
  };
  return {
    host,
    push: (change) => {
      for (const handler of handlers) handler(change);
    },
    disposeCount: () => disposeCalls,
  };
}

const directories: HostDirectoryService[] = [];
let restoreDocumentHidden: (() => void) | null = null;

function makeDirectory(
  options: Omit<HostDirectoryServiceOptions, "onRegistryPollTick"> &
    Partial<Pick<HostDirectoryServiceOptions, "onRegistryPollTick">>,
): HostDirectoryService {
  // Defaulted here rather than at every call site: these cases are about the
  // directory's own behavior, and the poll-tick callback is the F22 wiring
  // that belongs to whoever composes the service. A case that cares passes
  // its own.
  const directory = new HostDirectoryService({
    onRegistryPollTick: null,
    ...options,
  });
  directories.push(directory);
  return directory;
}

function setDocumentHidden(hidden: boolean): void {
  if (restoreDocumentHidden === null) {
    const descriptor = Object.getOwnPropertyDescriptor(document, "hidden");
    restoreDocumentHidden = () => {
      if (descriptor === undefined) {
        Reflect.deleteProperty(document, "hidden");
        return;
      }
      Object.defineProperty(document, "hidden", descriptor);
    };
  }
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => hidden,
  });
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  window.localStorage.removeItem(LAST_LOCAL_HOST_ID_STORAGE_KEY);
});

afterEach(() => {
  for (const directory of directories.splice(0)) {
    directory.dispose();
  }
  window.localStorage.removeItem(LAST_LOCAL_HOST_ID_STORAGE_KEY);
  useSettingsHostScopeStore.getState().setScopedHostId(null);
  if (restoreDocumentHidden !== null) {
    restoreDocumentHidden();
    restoreDocumentHidden = null;
  }
  vi.useRealTimers();
});

/** A `RemoteHostFetcher` that returns queued outcomes in order and counts calls. */
function queuedFetcher(outcomes: readonly RemoteHostFetchOutcome[]): {
  readonly fetcher: RemoteHostFetcher;
  readonly callCount: () => number;
} {
  const queue = [...outcomes];
  let calls = 0;
  const fetcher: RemoteHostFetcher = () => {
    calls += 1;
    const next = queue.shift();
    if (next === undefined) {
      throw new Error("queuedFetcher exhausted");
    }
    return Promise.resolve(next);
  };
  return { fetcher, callCount: () => calls };
}

/**
 * A `RemoteHostFetcher` where each call returns a promise the test resolves
 * explicitly, by call index - for pinning identity-scoping ordering (a caller
 * mid-flight, an identity switch, a late resolution) that `queuedFetcher`'s
 * synchronous resolution can't express.
 */
function deferredFetcher(): {
  readonly fetcher: RemoteHostFetcher;
  readonly callCount: () => number;
  readonly resolve: (
    callIndex: number,
    outcome: RemoteHostFetchOutcome,
  ) => void;
} {
  const resolvers = new Map<
    number,
    (outcome: RemoteHostFetchOutcome) => void
  >();
  let calls = 0;
  const fetcher: RemoteHostFetcher = () =>
    new Promise<RemoteHostFetchOutcome>((resolve) => {
      resolvers.set(calls, resolve);
      calls += 1;
    });
  return {
    fetcher,
    callCount: () => calls,
    resolve: (callIndex, outcome) => {
      const resolver = resolvers.get(callIndex);
      if (resolver === undefined) {
        throw new Error(`deferredFetcher: no call at index ${callIndex} yet`);
      }
      resolver(outcome);
    },
  };
}

const accountAHostEntry: HostDirectoryEntry = {
  hostId: "account-a-host",
  label: "Account A Host",
  kind: "remote",
  websocketUrl: "wss://account-a.traycer.invalid/rpc",
  version: "0.0.0-mock",
  transportDialability: "dialable",
};

const accountBHostEntry: HostDirectoryEntry = {
  hostId: "account-b-host",
  label: "Account B Host",
  kind: "remote",
  websocketUrl: "wss://account-b.traycer.invalid/rpc",
  version: "0.0.0-mock",
  transportDialability: "dialable",
};

describe("HostDirectoryService", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("P2 FIX - tells listeners when the shell seed adopts a local host id, on a machine whose host has not announced", async () => {
    // The seed is the ONE `adoptLocalHostId` caller with no emit behind it -
    // `onLocalHostChange` emits immediately after its own call, and the poll
    // path's `emitIfSnapshotChanged` can decline. It is also a real state
    // change: `snapshot()` reads `lastKnownLocalHostId` to neutralise this
    // machine's registry twin into a `bootingLocalEntry`.
    //
    // A machine with NO local snapshot is the population that matters, and it
    // is also the cold start: nothing has announced, so the durable id is the
    // only thing that can answer "which host is mine" - and a consumer that
    // subscribed and was never told still believes the answer is null.
    const host = makeHost(null);
    const directory = makeDirectory({
      authContextId: null,
      credentialGeneration: null,
      runnerHost: host,
      localHostIdSeeder: () => Promise.resolve("desktop-pid-123"),
      remoteFetcher: null,
    });
    await directory.start();

    expect(directory.getLocalHostId()).toBe("desktop-pid-123");
    // The live entry is null here and always was - which is exactly why a
    // consumer reading `getLocalEntry()?.hostId` cannot see this machine.
    expect(directory.getLocalEntry()).toBeNull();
  });

  it("P2 FIX - and on the POLL reseed, where the merged snapshot is unchanged and emitIfSnapshotChanged would otherwise decline", async () => {
    // The start path happens to be covered already (the local-host
    // subscription emits right after the seed), so this is the arm that
    // actually needs the emit: the host announces itself to the SHELL later,
    // the poll picks the id up, and nothing else about the merged snapshot
    // moves - no local entry, no remote rows - so the poll's own
    // change-gated emit correctly declines and every consumer is left
    // believing this machine has no id.
    vi.useFakeTimers();
    const host = makeHost(null);
    let seededId: string | null = null;
    const directory = makeDirectory({
      authContextId: null,
      credentialGeneration: null,
      runnerHost: host,
      localHostIdSeeder: () => Promise.resolve(seededId),
      remoteFetcher: null,
    });

    await directory.start();
    expect(directory.getLocalHostId()).toBeNull();

    let notifications = 0;
    directory.onChange(() => {
      notifications += 1;
    });

    // The shell can answer now. Nothing else has changed.
    seededId = "desktop-pid-123";
    await vi.advanceTimersByTimeAsync(HOST_DIRECTORY_REFRESH_POLL_MS);

    expect(directory.getLocalHostId()).toBe("desktop-pid-123");
    expect(await directory.list()).toEqual([]);
    expect(notifications).toBe(1);
  });

  it("seeds the local entry from the runner-host onLocalHostChange subscription", async () => {
    const host = makeHost(localSnapshot);
    const directory = makeDirectory({
      authContextId: null,
      credentialGeneration: null,
      runnerHost: host,
      localHostIdSeeder: null,
      remoteFetcher: null,
    });
    await directory.start();

    const entries = await directory.list();
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("local");
    expect(entries[0].hostId).toBe(localSnapshot.hostId);
    expect(entries[0].label).toBe(localSnapshot.displayName);
    expect(entries[0].websocketUrl).toBe(localSnapshot.websocketUrl);
  });

  it("uses a customized local host display name when the runner snapshot provides one", async () => {
    const renamedSnapshot: LocalHostSnapshot = {
      ...localSnapshot,
      displayName: "Design Studio",
      availability: "available",
    };
    const host = makeHost(renamedSnapshot);
    const directory = makeDirectory({
      authContextId: null,
      credentialGeneration: null,
      runnerHost: host,
      localHostIdSeeder: null,
      remoteFetcher: null,
    });
    await directory.start();

    expect(directory.getLocalEntry()?.label).toBe("Design Studio");
  });

  it("composes local snapshots with the configured remote fetcher", async () => {
    const host = makeHost(localSnapshot);
    const remoteFetcher: RemoteHostFetcher = () =>
      Promise.resolve({ kind: "hosts", entries: [mockRemoteHostEntry] });
    const directory = makeDirectory({
      authContextId: null,
      credentialGeneration: null,
      runnerHost: host,
      localHostIdSeeder: null,
      remoteFetcher,
    });
    await directory.start();

    const entries = await directory.list();
    expect(entries.map((e) => e.kind)).toEqual(["local", "remote"]);
  });

  it("deduplicates the registered remote copy of the local host", async () => {
    const host = makeHost(localSnapshot);
    const registeredLocalHostEntry: HostDirectoryEntry = {
      hostId: localSnapshot.hostId,
      label: "Registry copy",
      kind: "remote",
      websocketUrl: "wss://relay.traycer.invalid/attach",
      version: localSnapshot.version,
      transportDialability: "dialable",
    };
    const remoteFetcher: RemoteHostFetcher = () =>
      Promise.resolve({
        kind: "hosts",
        entries: [registeredLocalHostEntry, mockRemoteHostEntry],
      });
    const directory = makeDirectory({
      authContextId: null,
      credentialGeneration: null,
      runnerHost: host,
      localHostIdSeeder: null,
      remoteFetcher,
    });
    await directory.start();

    const entries = await directory.list();
    expect(entries.map((entry) => entry.hostId)).toEqual([
      localSnapshot.hostId,
      mockRemoteHostEntry.hostId,
    ]);
    expect(directory.findById(localSnapshot.hostId)?.kind).toBe("local");
    expect(directory.getDefaultEntry()?.hostId).toBe(localSnapshot.hostId);
  });

  it("defaults to the shared stubbed remote fetcher when none is supplied", async () => {
    const host = makeHost(null);
    const directory = makeDirectory({
      authContextId: null,
      credentialGeneration: null,
      runnerHost: host,
      localHostIdSeeder: null,
      remoteFetcher: null,
    });
    await directory.start();

    expect(await directory.list()).toEqual([]);
  });

  it("prefers the local entry as the default when one exists", async () => {
    const host = makeHost(localSnapshot);
    const directory = makeDirectory({
      authContextId: null,
      credentialGeneration: null,
      runnerHost: host,
      localHostIdSeeder: null,
      remoteFetcher: () =>
        Promise.resolve({ kind: "hosts", entries: [mockRemoteHostEntry] }),
    });
    await directory.start();

    const def = directory.getDefaultEntry();
    expect(def).not.toBeNull();
    expect(def?.kind).toBe("local");
  });

  it("falls back to the single remote entry when no local host exists and the directory has exactly one entry", async () => {
    const host = makeHost(null);
    const directory = makeDirectory({
      authContextId: null,
      credentialGeneration: null,
      runnerHost: host,
      localHostIdSeeder: null,
      remoteFetcher: () =>
        Promise.resolve({ kind: "hosts", entries: [mockRemoteHostEntry] }),
    });
    await directory.start();

    const def = directory.getDefaultEntry();
    expect(def?.hostId).toBe(mockRemoteHostEntry.hostId);
    expect(directory.getCardinality()).toBe("one");
  });

  it("does NOT auto-default to a remote entry when the mobile directory has multiple entries (Flow 6)", async () => {
    // Regression: previously `getDefaultEntry()` fell through to
    // `remoteEntries[0]`, which silently bound the first remote on mobile
    // and bypassed the mounted `<HostPicker />` UX. Mobile must wait for
    // an explicit pick when cardinality is "many".
    const host = makeHost(null);
    const secondRemote: HostDirectoryEntry = {
      hostId: "mock-remote-2",
      label: "Second Remote",
      kind: "remote",
      websocketUrl: "wss://mock-remote-2.traycer.invalid/rpc",
      version: "0.0.0-mock",
      transportDialability: "dialable",
    };
    const directory = makeDirectory({
      authContextId: null,
      credentialGeneration: null,
      runnerHost: host,
      localHostIdSeeder: null,
      remoteFetcher: () =>
        Promise.resolve({
          kind: "hosts",
          entries: [mockRemoteHostEntry, secondRemote],
        }),
    });
    await directory.start();

    expect(directory.getCardinality()).toBe("many");
    expect(directory.getDefaultEntry()).toBeNull();
  });

  it("reports cardinality 'zero' when the directory has no local or remote entries", async () => {
    const host = makeHost(null);
    const directory = makeDirectory({
      authContextId: null,
      credentialGeneration: null,
      runnerHost: host,
      localHostIdSeeder: null,
      remoteFetcher: null,
    });
    await directory.start();

    expect(directory.getCardinality()).toBe("zero");
    expect(directory.getDefaultEntry()).toBeNull();
  });

  it("collapses a REJECTED fetcher into the failed outcome - refresh() resolves, prior remote entries are retained, and the next refresh recovers", async () => {
    const host = makeHost(localSnapshot);
    const calls = { count: 0 };
    const fetcher: RemoteHostFetcher = () => {
      calls.count += 1;
      if (calls.count === 1) {
        return Promise.resolve({
          kind: "hosts",
          entries: [rememberedRemoteHostEntry],
        });
      }
      if (calls.count === 2) {
        return Promise.reject(new Error("ipc bridge rejected"));
      }
      return Promise.resolve({
        kind: "hosts",
        entries: [rememberedRemoteHostEntry, secondRemoteHostEntry],
      });
    };
    const directory = makeDirectory({
      authContextId: null,
      credentialGeneration: null,
      runnerHost: host,
      localHostIdSeeder: null,
      remoteFetcher: fetcher,
    });
    await directory.start();

    // The rejecting fetch takes the designed failed-outcome path: the promise
    // resolves and the last-known remote entries survive.
    const retained = await directory.refresh();
    expect(retained.map((entry) => entry.hostId)).toContain(
      rememberedRemoteHostEntry.hostId,
    );

    const recovered = await directory.refresh();
    expect(recovered.map((entry) => entry.hostId)).toContain(
      secondRemoteHostEntry.hostId,
    );
  });

  it("a fetcher that rejects on the FIRST refresh still lets start() resolve instead of tearing the host runtime down", async () => {
    const host = makeHost(localSnapshot);
    const calls = { count: 0 };
    const fetcher: RemoteHostFetcher = () => {
      calls.count += 1;
      if (calls.count === 1) {
        return Promise.reject(new Error("ipc bridge rejected at startup"));
      }
      return Promise.resolve({
        kind: "hosts",
        entries: [rememberedRemoteHostEntry],
      });
    };
    const directory = makeDirectory({
      authContextId: null,
      credentialGeneration: null,
      runnerHost: host,
      localHostIdSeeder: null,
      remoteFetcher: fetcher,
    });

    await expect(directory.start()).resolves.toBeUndefined();

    // The service is fully operational afterwards: the next refresh merges
    // the remote entries as usual.
    const entries = await directory.refresh();
    expect(entries.map((entry) => entry.hostId)).toContain(
      rememberedRemoteHostEntry.hostId,
    );
  });

  it("refreshes the local entry when the runner emits an update", async () => {
    const host = makeHost(null);
    const directory = makeDirectory({
      authContextId: null,
      credentialGeneration: null,
      runnerHost: host,
      localHostIdSeeder: null,
      remoteFetcher: null,
    });
    await directory.start();

    const changes: Array<{ count: number; hasLocal: boolean }> = [];
    directory.onChange((entries, local) => {
      changes.push({ count: entries.length, hasLocal: local !== null });
    });

    host.setLocalHost(localSnapshot);
    host.setLocalHost(null);

    expect(changes).toEqual([
      { count: 1, hasLocal: true },
      { count: 0, hasLocal: false },
    ]);
  });

  it("reflects the current local snapshot even when start() runs after the host already has one", async () => {
    // Mirrors the desktop-bridge timing where the preload has captured the
    // current snapshot before `gui-app` starts the directory service. The
    // service must observe the replay emitted by `onLocalHostChange` on
    // subscribe and list the local entry immediately - without any separate
    // `getLocalHost()` accessor.
    const host = makeHost(null);
    host.setLocalHost(localSnapshot);

    const directory = makeDirectory({
      authContextId: null,
      credentialGeneration: null,
      runnerHost: host,
      localHostIdSeeder: null,
      remoteFetcher: null,
    });
    await directory.start();

    const entries = await directory.list();
    expect(entries).toHaveLength(1);
    expect(entries[0].hostId).toBe(localSnapshot.hostId);
    expect(directory.getLocalEntry()?.hostId).toBe(localSnapshot.hostId);
  });

  it("resolves entries by id across local and remote", async () => {
    const host = makeHost(localSnapshot);
    const directory = makeDirectory({
      authContextId: null,
      credentialGeneration: null,
      runnerHost: host,
      localHostIdSeeder: null,
      remoteFetcher: () =>
        Promise.resolve({ kind: "hosts", entries: [mockRemoteHostEntry] }),
    });
    await directory.start();

    expect(directory.findById(localSnapshot.hostId)?.kind).toBe("local");
    expect(directory.findById(mockRemoteHostEntry.hostId)?.kind).toBe("remote");
    expect(directory.findById("missing")).toBeNull();
  });

  it("polls remote hosts every 15s while visible", async () => {
    vi.useFakeTimers();
    const host = makeHost(null);
    let remoteEntries: readonly HostDirectoryEntry[] = [];
    let fetchCalls = 0;
    const fetcher: RemoteHostFetcher = () => {
      fetchCalls += 1;
      return Promise.resolve({ kind: "hosts", entries: remoteEntries });
    };
    const directory = makeDirectory({
      authContextId: null,
      credentialGeneration: null,
      runnerHost: host,
      localHostIdSeeder: null,
      remoteFetcher: fetcher,
    });

    await directory.start();
    expect(fetchCalls).toBe(1);
    expect(await directory.list()).toEqual([]);

    remoteEntries = [mockRemoteHostEntry];
    await vi.advanceTimersByTimeAsync(HOST_DIRECTORY_REFRESH_POLL_MS);

    expect(fetchCalls).toBe(2);
    expect(directory.findById(mockRemoteHostEntry.hostId)).not.toBeNull();
  });

  it("pauses interval refreshes while hidden and refreshes immediately on visibility return", async () => {
    vi.useFakeTimers();
    setDocumentHidden(false);
    const host = makeHost(null);
    let remoteEntries: readonly HostDirectoryEntry[] = [];
    let fetchCalls = 0;
    const fetcher: RemoteHostFetcher = () => {
      fetchCalls += 1;
      return Promise.resolve({ kind: "hosts", entries: remoteEntries });
    };
    const directory = makeDirectory({
      authContextId: null,
      credentialGeneration: null,
      runnerHost: host,
      localHostIdSeeder: null,
      remoteFetcher: fetcher,
    });

    await directory.start();
    setDocumentHidden(true);
    remoteEntries = [mockRemoteHostEntry];

    await vi.advanceTimersByTimeAsync(HOST_DIRECTORY_REFRESH_POLL_MS * 2);

    expect(fetchCalls).toBe(1);
    expect(directory.findById(mockRemoteHostEntry.hostId)).toBeNull();

    setDocumentHidden(false);
    document.dispatchEvent(new Event("visibilitychange"));
    await flushPromises();

    expect(fetchCalls).toBe(2);
    expect(directory.findById(mockRemoteHostEntry.hostId)).not.toBeNull();
  });

  it("rearms the poll interval on a visibility-triggered refresh instead of also firing the stale pre-hidden schedule", async () => {
    vi.useFakeTimers();
    setDocumentHidden(false);
    const host = makeHost(null);
    let fetchCalls = 0;
    const fetcher: RemoteHostFetcher = () => {
      fetchCalls += 1;
      return Promise.resolve({ kind: "hosts", entries: [] });
    };
    const directory = makeDirectory({
      authContextId: null,
      credentialGeneration: null,
      runnerHost: host,
      localHostIdSeeder: null,
      remoteFetcher: fetcher,
    });

    await directory.start();
    expect(fetchCalls).toBe(1);

    // Resume/visibility-change fires partway through the poll window - this
    // should rearm the interval from this point, not just refresh once while
    // leaving the original schedule armed.
    await vi.advanceTimersByTimeAsync(HOST_DIRECTORY_REFRESH_POLL_MS / 2);
    document.dispatchEvent(new Event("visibilitychange"));
    await flushPromises();
    expect(fetchCalls).toBe(2);

    // The stale pre-reset schedule would have fired here too; the rearmed
    // schedule must not fire until a full window from the resume point.
    await vi.advanceTimersByTimeAsync(HOST_DIRECTORY_REFRESH_POLL_MS / 2 + 1);
    expect(fetchCalls).toBe(2);

    await vi.advanceTimersByTimeAsync(HOST_DIRECTORY_REFRESH_POLL_MS / 2);
    expect(fetchCalls).toBe(3);
  });

  it("does not notify onChange when a poll delivers a field-identical snapshot, and still notifies when one actually changes", async () => {
    const host = makeHost(null);
    const { fetcher } = queuedFetcher([
      { kind: "hosts", entries: [mockRemoteHostEntry] },
      // Fresh object literals, field-identical to the previous batch - what a
      // real 15s poll produces when nothing about the registry changed. An
      // unconditional emit here re-rendered/refetched every `onChange`
      // consumer app-wide on every tick (terminal tiles unmounted through
      // the reachability gate and reset to "Starting terminal session…").
      { kind: "hosts", entries: [{ ...mockRemoteHostEntry }] },
      {
        kind: "hosts",
        entries: [{ ...mockRemoteHostEntry, label: "Renamed" }],
      },
      { kind: "hosts", entries: [mockRemoteHostEntry, secondRemoteHostEntry] },
    ]);
    const directory = makeDirectory({
      authContextId: null,
      credentialGeneration: null,
      runnerHost: host,
      localHostIdSeeder: null,
      remoteFetcher: fetcher,
    });
    await directory.start();

    const observed: Array<readonly HostDirectoryEntry[]> = [];
    directory.onChange((entries) => {
      observed.push(entries);
    });

    await directory.refresh();
    expect(observed).toEqual([]);

    // A changed FIELD on the same host must still reach every consumer -
    // without this leg a "never emit" regression would pass the case above.
    await directory.refresh();
    expect(observed).toHaveLength(1);
    expect(observed[0]?.[0]?.label).toBe("Renamed");

    // As must a changed set of hosts.
    await directory.refresh();
    expect(observed).toHaveLength(2);
    expect(observed[1]).toHaveLength(2);
  });

  // R-1's key-rotation sweep (`host-key-rotation-sweep.ts`) can only ever see
  // a rotation if THIS emit happens at all: `hostDirectoryEntriesEqual`'s
  // `remotePublicKeyOf(a) === remotePublicKeyOf(b)` comparison is the single
  // line that makes a key-only change observable rather than swallowed as a
  // field-identical poll tick. Nothing states that outside the source
  // comment, and every suite pinning the sweep itself supplies its own
  // directory double - none of them would notice this comparison deleted.
  // The REAL projection (`hostListItemToDirectoryEntry`), not a hand-built
  // `RemoteHostDirectoryEntry`, so a change to what the projector reads as
  // "the key" is caught here too.
  it("fans out onChange when a poll's ONLY change is a remote entry's public key", async () => {
    const item = {
      hostId: "rotating-registry-host",
      displayName: "Rotating Registry Host",
      platform: "Ubuntu",
      kind: "personal",
      publicKey: "pk-generation-1",
      createdAt: "2026-07-01T12:00:00.000Z",
      status: {
        connectivity: "connectable",
        viewerReachability: "ok",
        clientCloud: "ok",
        updateState: "current",
        appVersion: "1.4.2",
        lastSeenAt: "2026-07-03T12:00:00.000Z",
      },
      updatePolicy: "manual",
    } as const;
    const relayUrl = "wss://relay.example.test/attach";
    const beforeRotation = hostListItemToDirectoryEntry(
      item,
      relayUrl,
      PLAN_ALLOWS_REMOTE,
    );
    // Same row in every other respect - `connectable`, so the derived
    // unavailability verdict and the relay-fuse-grace flag (always `false`
    // off `offline`) cannot be what moves the comparison. Only `publicKey`
    // differs between the two projections below.
    const afterRotation = hostListItemToDirectoryEntry(
      { ...item, publicKey: "pk-generation-2" },
      relayUrl,
      PLAN_ALLOWS_REMOTE,
    );
    expect(
      isRemoteHostDirectoryEntry(beforeRotation) &&
        isRemoteHostDirectoryEntry(afterRotation) &&
        beforeRotation.label === afterRotation.label &&
        beforeRotation.kind === afterRotation.kind &&
        beforeRotation.websocketUrl === afterRotation.websocketUrl &&
        beforeRotation.version === afterRotation.version &&
        beforeRotation.transportDialability ===
          afterRotation.transportDialability &&
        beforeRotation.relayFuseGrace === afterRotation.relayFuseGrace,
    ).toBe(true);

    const host = makeHost(null);
    const { fetcher } = queuedFetcher([
      { kind: "hosts", entries: [beforeRotation] },
      { kind: "hosts", entries: [afterRotation] },
    ]);
    const directory = makeDirectory({
      authContextId: null,
      credentialGeneration: null,
      runnerHost: host,
      localHostIdSeeder: null,
      remoteFetcher: fetcher,
    });
    await directory.start();

    const observed: Array<readonly HostDirectoryEntry[]> = [];
    directory.onChange((entries) => {
      observed.push(entries);
    });

    await directory.refresh();

    expect(observed).toHaveLength(1);
    const emitted = observed[0]?.find(
      (entry) => entry.hostId === "rotating-registry-host",
    );
    expect(
      emitted !== undefined && isRemoteHostDirectoryEntry(emitted)
        ? emitted.publicKey
        : null,
    ).toBe("pk-generation-2");
  });

  it("notifies onChange when a poll adds a host even though the previously emitted entries are unchanged", async () => {
    const host = makeHost(null);
    const { fetcher } = queuedFetcher([
      { kind: "hosts", entries: [mockRemoteHostEntry] },
      { kind: "hosts", entries: [mockRemoteHostEntry, secondRemoteHostEntry] },
    ]);
    const directory = makeDirectory({
      authContextId: null,
      credentialGeneration: null,
      runnerHost: host,
      localHostIdSeeder: null,
      remoteFetcher: fetcher,
    });
    await directory.start();

    const observed: Array<readonly HostDirectoryEntry[]> = [];
    directory.onChange((entries) => {
      observed.push(entries);
    });

    await directory.refresh();

    expect(observed).toHaveLength(1);
    expect(observed[0]?.map((entry) => entry.hostId)).toEqual([
      mockRemoteHostEntry.hostId,
      secondRemoteHostEntry.hostId,
    ]);
  });

  it("keeps the no-change emit suppression armed against the LAST EMITTED snapshot, not the last poll", async () => {
    const host = makeHost(null);
    const { fetcher } = queuedFetcher([
      { kind: "hosts", entries: [mockRemoteHostEntry] },
      {
        kind: "hosts",
        entries: [{ ...mockRemoteHostEntry, label: "Renamed" }],
      },
      {
        kind: "hosts",
        entries: [{ ...mockRemoteHostEntry, label: "Renamed" }],
      },
    ]);
    const directory = makeDirectory({
      authContextId: null,
      credentialGeneration: null,
      runnerHost: host,
      localHostIdSeeder: null,
      remoteFetcher: fetcher,
    });
    await directory.start();

    const observed: Array<readonly HostDirectoryEntry[]> = [];
    directory.onChange((entries) => {
      observed.push(entries);
    });

    // Change, then hold. The second poll re-delivers the CHANGED value, which
    // is now the emitted baseline - it must not emit a second time.
    await directory.refresh();
    await directory.refresh();

    expect(observed).toHaveLength(1);
  });

  it("notifies onChange when an offline row's ONLY change is its relay-fuse grace aging past the cap", async () => {
    // The registry row itself never changes: same host, same `offline`
    // verdict, same `lastSeenAt`. What changes is the clock - the projection
    // recomputes `relayFuseGrace` from recency on every fetch, so once
    // `lastSeenAt` ages past RELAY_FUSE_MAX_ATTACH_MS the flag flips while
    // every other compared field (including the derived verdict) stays
    // identical. Swallowing that emission left every consumer holding
    // `relayFuseGrace: true` forever - recovery dials permitted indefinitely
    // past the documented 4h cap.
    const lastSeenAt = "2026-07-03T12:00:00.000Z";
    const lastSeenMs = Date.parse(lastSeenAt);
    const item = {
      hostId: "fuse-aging-host",
      displayName: "Fuse Aging Host",
      platform: "Ubuntu",
      kind: "personal",
      publicKey: "pk-fuse-aging-host",
      createdAt: "2026-07-01T12:00:00.000Z",
      status: {
        connectivity: "offline",
        viewerReachability: "unknown",
        clientCloud: "ok",
        updateState: "current",
        appVersion: "1.4.2",
        lastSeenAt,
      },
      updatePolicy: "manual",
    } as const;
    // The SAME registry row projected at two moments, by the REAL projection
    // (not hand-flipped flags): one minute after last-seen, then one tick
    // past the fuse cap.
    const nowSpy = vi.spyOn(Date, "now");
    nowSpy.mockReturnValue(lastSeenMs + 60_000);
    const inGrace = hostListItemToDirectoryEntry(
      item,
      "wss://relay.example.test/attach",
      PLAN_ALLOWS_REMOTE,
    );
    nowSpy.mockReturnValue(lastSeenMs + RELAY_FUSE_MAX_ATTACH_MS + 1);
    const aged = hostListItemToDirectoryEntry(
      item,
      "wss://relay.example.test/attach",
      PLAN_ALLOWS_REMOTE,
    );
    nowSpy.mockRestore();
    expect(inGrace.relayFuseGrace).toBe(true);
    expect(aged.relayFuseGrace).toBe(false);

    const host = makeHost(null);
    const { fetcher } = queuedFetcher([
      { kind: "hosts", entries: [inGrace] },
      { kind: "hosts", entries: [aged] },
    ]);
    const directory = makeDirectory({
      authContextId: null,
      credentialGeneration: null,
      runnerHost: host,
      localHostIdSeeder: null,
      remoteFetcher: fetcher,
    });
    await directory.start();

    const observed: Array<readonly HostDirectoryEntry[]> = [];
    directory.onChange((entries) => {
      observed.push(entries);
    });

    await directory.refresh();

    expect(observed).toHaveLength(1);
    const emitted = observed[0]?.find(
      (entry) => entry.hostId === "fuse-aging-host",
    );
    expect(
      emitted !== undefined && isRemoteHostDirectoryEntry(emitted)
        ? emitted.relayFuseGrace
        : null,
    ).toBe(false);
  });

  it("retains the last-known remote entries when a refresh fails (T20 / audit P4)", async () => {
    // This used to also assert the bound SELECTION survived the failed
    // refresh (`selectById` / `getSelected()` / `onSelectionChange`). P4.2
    // deleted selection from `HostDirectoryService` - that half of the claim
    // has no post-slot equivalent here and is dropped; entry retention is
    // the surviving contract.
    const host = makeHost(null);
    const { fetcher } = queuedFetcher([
      { kind: "hosts", entries: [mockRemoteHostEntry] },
      { kind: "failed" },
    ]);
    const directory = makeDirectory({
      authContextId: null,
      credentialGeneration: null,
      runnerHost: host,
      localHostIdSeeder: null,
      remoteFetcher: fetcher,
    });
    await directory.start();

    await directory.refresh();

    expect(await directory.list()).toHaveLength(1);
  });

  it("clears remote entries when a refresh reports signed-out", async () => {
    const host = makeHost(null);
    const { fetcher } = queuedFetcher([
      { kind: "hosts", entries: [mockRemoteHostEntry] },
      { kind: "signed-out" },
    ]);
    const directory = makeDirectory({
      authContextId: null,
      credentialGeneration: null,
      runnerHost: host,
      localHostIdSeeder: null,
      remoteFetcher: fetcher,
    });
    await directory.start();
    expect(await directory.list()).toHaveLength(1);

    await directory.refresh();

    expect(await directory.list()).toEqual([]);
  });

  it("coalesces concurrent refresh() calls onto a single fetch", async () => {
    const host = makeHost(null);
    let calls = 0;
    const pending: {
      resolve: ((outcome: RemoteHostFetchOutcome) => void) | null;
    } = { resolve: null };
    const fetcher: RemoteHostFetcher = () => {
      calls += 1;
      return new Promise<RemoteHostFetchOutcome>((resolve) => {
        pending.resolve = resolve;
      });
    };
    const directory = makeDirectory({
      authContextId: null,
      credentialGeneration: null,
      runnerHost: host,
      localHostIdSeeder: null,
      remoteFetcher: fetcher,
    });

    const startPromise = directory.start();
    const refreshA = directory.refresh();
    const refreshB = directory.refresh();

    expect(calls).toBe(1);
    pending.resolve?.({ kind: "hosts", entries: [mockRemoteHostEntry] });

    await Promise.all([startPromise, refreshA, refreshB]);

    expect(calls).toBe(1);
    expect(await directory.list()).toHaveLength(1);
  });

  it("coalesces overlapping explicit and interval refresh triggers onto a single fetch", async () => {
    vi.useFakeTimers();
    const host = makeHost(null);
    let calls = 0;
    const pending: {
      resolve: ((outcome: RemoteHostFetchOutcome) => void) | null;
    } = { resolve: null };
    const fetcher: RemoteHostFetcher = () => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve({ kind: "hosts", entries: [] });
      }
      return new Promise<RemoteHostFetchOutcome>((resolve) => {
        pending.resolve = resolve;
      });
    };
    const directory = makeDirectory({
      authContextId: null,
      credentialGeneration: null,
      runnerHost: host,
      localHostIdSeeder: null,
      remoteFetcher: fetcher,
    });

    await directory.start();
    const explicitRefresh = directory.refresh();
    expect(calls).toBe(2);

    await vi.advanceTimersByTimeAsync(HOST_DIRECTORY_REFRESH_POLL_MS);
    expect(calls).toBe(2);

    pending.resolve?.({ kind: "hosts", entries: [mockRemoteHostEntry] });
    await explicitRefresh;
    await flushPromises();

    expect(calls).toBe(2);
    expect(await directory.list()).toHaveLength(1);
  });

  describe("machine-owned host id vs the registry twin", () => {
    /**
     * The registry also lists this machine's own host. During a local restart
     * (reinstall/update) the local snapshot is null, so the registry's
     * remote-kind twin - "available" by presence lease, dialable on paper, but
     * reached through the relay - is the only entry carrying that id. Binding
     * it renders the dead-end unavailable card and disables the local
     * provisioning lifecycle.
     */
    const ownRegistryTwin: HostDirectoryEntry = {
      hostId: localSnapshot.hostId,
      label: "hardiks-macbook",
      kind: "remote",
      websocketUrl: "wss://relay.traycer.invalid/attach",
      version: "1.2.2",
      transportDialability: "dialable",
    };

    it("presents the machine's own registry twin as a non-dialable local entry", async () => {
      window.localStorage.setItem(
        LAST_LOCAL_HOST_ID_STORAGE_KEY,
        localSnapshot.hostId,
      );
      const host = makeHost(null);
      const directory = makeDirectory({
        authContextId: null,
        credentialGeneration: null,
        runnerHost: host,
        localHostIdSeeder: null,
        remoteFetcher: () =>
          Promise.resolve({
            kind: "hosts",
            entries: [ownRegistryTwin, secondRemoteHostEntry],
          }),
      });
      await directory.start();

      const entries = await directory.list();
      expect(entries).toHaveLength(2);
      // `kind: local` keeps `localTarget` true so the provisioning/Retry card
      // stays reachable; `websocketUrl: null` is what refuses the relay.
      expect(entries[0]).toEqual({
        hostId: localSnapshot.hostId,
        label: "hardiks-macbook",
        kind: "local",
        websocketUrl: null,
        version: "1.2.2",
        // Not the twin's presence lease: `not-dialable` is the truth, and it
        // is what leaves a `not-dialable -> dialable` edge for dialability
        // subscribers (e.g. landing-terminal tombstone recovery) when the real
        // host finally publishes.
        transportDialability: "not-dialable",
      });
      expect(entries[1]).toEqual(secondRemoteHostEntry);
    });

    it("re-covers the id through the local arm the moment the host publishes", async () => {
      window.localStorage.setItem(
        LAST_LOCAL_HOST_ID_STORAGE_KEY,
        localSnapshot.hostId,
      );
      const host = makeHost(null);
      const directory = makeDirectory({
        authContextId: null,
        credentialGeneration: null,
        runnerHost: host,
        localHostIdSeeder: null,
        remoteFetcher: () =>
          Promise.resolve({ kind: "hosts", entries: [ownRegistryTwin] }),
      });
      await directory.start();
      expect((await directory.list())[0].websocketUrl).toBeNull();

      host.setLocalHost(localSnapshot);

      const entries = await directory.list();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        hostId: localSnapshot.hostId,
        kind: "local",
        websocketUrl: localSnapshot.websocketUrl,
      });
    });

    it("learns the machine's host id from the live snapshot and persists it across launches", async () => {
      const firstLaunchHost = makeHost(localSnapshot);
      const firstLaunch = makeDirectory({
        runnerHost: firstLaunchHost,
        authContextId: null,
        credentialGeneration: null,
        localHostIdSeeder: null,
        remoteFetcher: () => Promise.resolve({ kind: "hosts", entries: [] }),
      });
      await firstLaunch.start();
      expect(window.localStorage.getItem(LAST_LOCAL_HOST_ID_STORAGE_KEY)).toBe(
        localSnapshot.hostId,
      );

      // Next launch: the host is still restarting (no snapshot), but the
      // learned id already neutralises the registry twin.
      const secondLaunchHost = makeHost(null);
      const secondLaunch = makeDirectory({
        runnerHost: secondLaunchHost,
        authContextId: null,
        credentialGeneration: null,
        localHostIdSeeder: null,
        remoteFetcher: () =>
          Promise.resolve({ kind: "hosts", entries: [ownRegistryTwin] }),
      });
      await secondLaunch.start();
      expect((await secondLaunch.list())[0]).toMatchObject({
        kind: "local",
        websocketUrl: null,
      });
    });

    /**
     * Regression (Codex P1 on OSS #913): the FIRST launch of the build that
     * introduced the persisted key has nothing stored, and that launch is
     * exactly the reinstall this guard exists for - the host is down, so no
     * snapshot seeds it either. Without the shell's durable pid metadata the
     * twin would go unrecognised on the one launch that needed it most.
     */
    it("seeds the id from the shell's pid metadata when nothing is persisted yet", async () => {
      expect(
        window.localStorage.getItem(LAST_LOCAL_HOST_ID_STORAGE_KEY),
      ).toBeNull();
      const host = new MockRunnerHost({
        signInUrl: "https://auth.traycer.invalid/sign-in",
        authnBaseUrl: "http://localhost:5005",
        localHost: null,
        lastKnownLocalHostId: localSnapshot.hostId,
        hosts: [],
        workspaceFolderPickerPaths: undefined,
        hasLocalHost: undefined,
        traycerCli: undefined,
      });
      const directory = makeDirectory({
        authContextId: null,
        credentialGeneration: null,
        runnerHost: host,
        localHostIdSeeder: null,
        remoteFetcher: () =>
          Promise.resolve({ kind: "hosts", entries: [ownRegistryTwin] }),
      });
      await directory.start();

      expect((await directory.list())[0]).toMatchObject({
        hostId: localSnapshot.hostId,
        kind: "local",
        websocketUrl: null,
      });
      // Seeding also persists, so the next launch needs no shell round-trip.
      expect(window.localStorage.getItem(LAST_LOCAL_HOST_ID_STORAGE_KEY)).toBe(
        localSnapshot.hostId,
      );
    });

    /**
     * Regression (Codex P2 on OSS #913): seeding introduced an await BEFORE
     * the local-host subscription is installed, so a provider unmounting or
     * swapping its runner mid-flight can `dispose()` while nothing is
     * registered. Resuming past that point would install a listener no
     * `dispose()` can remove - an orphan dispatching stale callbacks for the
     * life of the page.
     */
    it("abandons startup when disposed while the shell seed is in flight", async () => {
      let releaseSeed: () => void = () => undefined;
      const host = new MockRunnerHost({
        signInUrl: "https://auth.traycer.invalid/sign-in",
        authnBaseUrl: "http://localhost:5005",
        localHost: null,
        hosts: [],
        workspaceFolderPickerPaths: undefined,
        hasLocalHost: undefined,
        traycerCli: undefined,
      });
      const seedGate = new Promise<void>((resolve) => {
        releaseSeed = resolve;
      });
      vi.spyOn(host, "getLastKnownLocalHostId").mockImplementation(async () => {
        await seedGate;
        return localSnapshot.hostId;
      });
      const onLocalHostChange = vi.spyOn(host, "onLocalHostChange");
      const directory = makeDirectory({
        authContextId: null,
        credentialGeneration: null,
        runnerHost: host,
        localHostIdSeeder: null,
        remoteFetcher: () => Promise.resolve({ kind: "hosts", entries: [] }),
      });

      const startPromise = directory.start();
      directory.dispose();
      releaseSeed();
      await startPromise;

      expect(onLocalHostChange).not.toHaveBeenCalled();
    });

    /**
     * Regression (CodeRabbit P2 on OSS #913): the host can be re-enrolled while
     * the renderer is not running. Treating the persisted value as
     * authoritative would neutralise the OBSOLETE twin while this machine's
     * current registry entry stayed remote-kind and relay-dialable.
     */
    it("prefers the shell's id over a stale persisted one after re-enrollment", async () => {
      window.localStorage.setItem(
        LAST_LOCAL_HOST_ID_STORAGE_KEY,
        "stale-host-id-from-a-previous-enrollment",
      );
      const reEnrolledTwin: HostDirectoryEntry = {
        ...ownRegistryTwin,
        hostId: "re-enrolled-host-id",
      };
      const directory = makeDirectory({
        authContextId: null,
        credentialGeneration: null,
        runnerHost: makeHost(null),
        localHostIdSeeder: () => Promise.resolve("re-enrolled-host-id"),
        remoteFetcher: () =>
          Promise.resolve({ kind: "hosts", entries: [reEnrolledTwin] }),
      });
      await directory.start();

      expect((await directory.list())[0]).toMatchObject({
        hostId: "re-enrolled-host-id",
        kind: "local",
        websocketUrl: null,
      });
      expect(window.localStorage.getItem(LAST_LOCAL_HOST_ID_STORAGE_KEY)).toBe(
        "re-enrolled-host-id",
      );
    });

    it("migrates a pinned Settings scope of the old local id on re-enrollment", async () => {
      // The Settings viewing scope is a holder like the persisted and live
      // selections: left behind, it keeps administering the dead registry
      // twin, then reads `vanished` once the twin deregisters.
      window.localStorage.setItem(
        LAST_LOCAL_HOST_ID_STORAGE_KEY,
        localSnapshot.hostId,
      );
      useSettingsHostScopeStore
        .getState()
        .setScopedHostId(localSnapshot.hostId);
      const host = makeHost(localSnapshot);
      const directory = makeDirectory({
        authContextId: null,
        credentialGeneration: null,
        runnerHost: host,
        localHostIdSeeder: null,
        remoteFetcher: () => Promise.resolve({ kind: "hosts", entries: [] }),
      });
      await directory.start();

      host.setLocalHost({
        ...localSnapshot,
        hostId: "re-enrolled-host-id",
      });
      await flushPromises();

      expect(useSettingsHostScopeStore.getState().scopedHostId).toBe(
        "re-enrolled-host-id",
      );
    });

    it("leaves a genuine remote Settings pin unchanged on re-enrollment", async () => {
      window.localStorage.setItem(
        LAST_LOCAL_HOST_ID_STORAGE_KEY,
        localSnapshot.hostId,
      );
      useSettingsHostScopeStore
        .getState()
        .setScopedHostId("some-other-remote-host");
      const host = makeHost(localSnapshot);
      const directory = makeDirectory({
        authContextId: null,
        credentialGeneration: null,
        runnerHost: host,
        localHostIdSeeder: null,
        remoteFetcher: () => Promise.resolve({ kind: "hosts", entries: [] }),
      });
      await directory.start();

      host.setLocalHost({
        ...localSnapshot,
        hostId: "re-enrolled-host-id",
      });
      await flushPromises();

      expect(useSettingsHostScopeStore.getState().scopedHostId).toBe(
        "some-other-remote-host",
      );
    });

    it("leaves other machines' remote hosts untouched", async () => {
      window.localStorage.setItem(
        LAST_LOCAL_HOST_ID_STORAGE_KEY,
        localSnapshot.hostId,
      );
      const host = makeHost(null);
      const directory = makeDirectory({
        authContextId: null,
        credentialGeneration: null,
        runnerHost: host,
        localHostIdSeeder: null,
        remoteFetcher: () =>
          Promise.resolve({
            kind: "hosts",
            entries: [rememberedRemoteHostEntry, secondRemoteHostEntry],
          }),
      });
      await directory.start();

      expect(await directory.list()).toEqual([
        rememberedRemoteHostEntry,
        secondRemoteHostEntry,
      ]);
    });
  });

  describe("identity-scoped refresh (auth context switch mid-flight)", () => {
    it("does not join a new identity's mandatory refresh to a stale identity's in-flight promise (the reviewer's P0 probe)", async () => {
      let currentAccount: string | null = "account-a";
      const { fetcher, callCount, resolve } = deferredFetcher();
      const directory = makeDirectory({
        authContextId: () => currentAccount,
        credentialGeneration: null,
        runnerHost: makeHost(null),
        localHostIdSeeder: null,
        remoteFetcher: fetcher,
      });

      // Account A's poll goes in flight and does not resolve yet.
      const aRefresh = directory.refresh();
      expect(callCount()).toBe(1);

      // A second caller still under A, while A's flight is pending, DOES join
      // - same identity, same memo slot. No new fetcher call.
      const aRefreshJoined = directory.refresh();
      expect(callCount()).toBe(1);

      // The account switch. B's refresh must NOT join A's still-pending
      // flight just because one is in flight - the memo is keyed by identity,
      // not by "is anything in flight".
      currentAccount = "account-b";
      const bRefresh = directory.refresh();
      expect(callCount()).toBe(2);

      resolve(1, { kind: "hosts", entries: [accountBHostEntry] });
      await bRefresh;
      expect((await directory.list()).map((entry) => entry.hostId)).toEqual([
        accountBHostEntry.hostId,
      ]);

      // A third caller under B, after B's own flight has settled and cleared
      // its slot, gets a fresh fetch - proving the slot was cleared by B's OWN
      // settle, not left dangling or falsely reused.
      const bRefreshAgain = directory.refresh();
      expect(callCount()).toBe(3);
      resolve(2, { kind: "hosts", entries: [accountBHostEntry] });
      await bRefreshAgain;

      // Let A's stale flight resolve too, late, so nothing is left dangling.
      // Its outcome must never have reached the directory - covered precisely
      // by the next test, asserted lightly here for completeness.
      resolve(0, { kind: "hosts", entries: [accountAHostEntry] });
      await aRefresh;
      await aRefreshJoined;
      expect((await directory.list()).map((entry) => entry.hostId)).toEqual([
        accountBHostEntry.hostId,
      ]);
    });

    it("discards a refresh that resolves after the identity has moved on, even though it started legally", async () => {
      let currentAccount: string | null = "account-a";
      const { fetcher, resolve } = deferredFetcher();
      const directory = makeDirectory({
        authContextId: () => currentAccount,
        credentialGeneration: null,
        runnerHost: makeHost(null),
        localHostIdSeeder: null,
        remoteFetcher: fetcher,
      });

      // A's refresh starts legally - A is current when it is issued.
      const aRefresh = directory.refresh();

      // The switch happens while A's fetch is still in flight.
      currentAccount = "account-b";
      const bRefresh = directory.refresh();

      // B's refresh resolves and commits FIRST.
      resolve(1, { kind: "hosts", entries: [accountBHostEntry] });
      await bRefresh;
      expect((await directory.list()).map((entry) => entry.hostId)).toEqual([
        accountBHostEntry.hostId,
      ]);

      // A's fetch NOW resolves - after the switch, carrying A's hosts. A
      // keyed memo alone would not stop this: `performRefresh` must re-check
      // the identity at commit time and discard the write, because the read
      // was issued for an identity that is no longer current.
      resolve(0, { kind: "hosts", entries: [accountAHostEntry] });
      await aRefresh;

      expect((await directory.list()).map((entry) => entry.hostId)).toEqual([
        accountBHostEntry.hostId,
      ]);
    });

    it("drops a previous account's retained hosts when the new identity's first read fails", async () => {
      let currentAccount: string | null = "account-a";
      const { fetcher, resolve } = deferredFetcher();
      const directory = makeDirectory({
        authContextId: () => currentAccount,
        credentialGeneration: null,
        runnerHost: makeHost(null),
        localHostIdSeeder: null,
        remoteFetcher: fetcher,
      });

      // Account A commits its directory.
      const aRefresh = directory.refresh();
      resolve(0, { kind: "hosts", entries: [accountAHostEntry] });
      await aRefresh;
      expect((await directory.list()).map((entry) => entry.hostId)).toEqual([
        accountAHostEntry.hostId,
      ]);

      // Direct A -> B switch; B's FIRST read fails. "Retain last-known on
      // failure" is only safe for the SAME identity - keeping the list here
      // would show A's machines (and keep A's selection bindable) under B's
      // signed-in session until some later read happened to succeed.
      currentAccount = "account-b";
      const bRefresh = directory.refresh();
      resolve(1, { kind: "failed" });
      await bRefresh;
      expect((await directory.list()).map((entry) => entry.hostId)).toEqual([]);

      // A later successful read populates B's own list...
      const bRetry = directory.refresh();
      resolve(2, { kind: "hosts", entries: [accountBHostEntry] });
      await bRetry;
      expect((await directory.list()).map((entry) => entry.hostId)).toEqual([
        accountBHostEntry.hostId,
      ]);

      // ...and a same-identity blip keeps its retention semantics: B's next
      // failure retains B's list, exactly as before.
      const bBlip = directory.refresh();
      resolve(3, { kind: "failed" });
      await bBlip;
      expect((await directory.list()).map((entry) => entry.hostId)).toEqual([
        accountBHostEntry.hostId,
      ]);
    });

    it("does not let an old-bearer 401 clear the directory under a new identity", async () => {
      let currentAccount: string | null = "account-a";
      const { fetcher, resolve } = deferredFetcher();
      const directory = makeDirectory({
        authContextId: () => currentAccount,
        credentialGeneration: null,
        runnerHost: makeHost(null),
        localHostIdSeeder: null,
        remoteFetcher: fetcher,
      });

      // A's fetch is in flight when the switch happens.
      const aRefresh = directory.refresh();
      currentAccount = "account-b";
      const bRefresh = directory.refresh();

      // B's refresh legitimately loads B's hosts.
      resolve(1, { kind: "hosts", entries: [accountBHostEntry] });
      await bRefresh;
      expect((await directory.list()).map((entry) => entry.hostId)).toEqual([
        accountBHostEntry.hostId,
      ]);

      // A's expired bearer earns a 401 - `signed-out` - and resolves late,
      // after the switch. Without the commit guard this clears the directory
      // exactly as a successful empty `hosts` result would, erasing the list
      // B had just legitimately loaded.
      resolve(0, { kind: "signed-out" });
      await aRefresh;

      expect((await directory.list()).map((entry) => entry.hostId)).toEqual([
        accountBHostEntry.hostId,
      ]);
    });
  });

  describe("credential-scoped destructive commits (same-user bearer rotation)", () => {
    // The counter these fence on is the REAL one, driven by a real rotation
    // through `DefaultRequestContextProvider` — not a local variable the test
    // increments where it thinks a rotation would be.
    //
    // That distinction is the reason this pair is here at all. The previous
    // version of these tests hand-drove a number, so they passed while
    // production was wired to an identity-transition counter that does not
    // move on a rotation at all: they proved the fence works GIVEN a credential
    // counter, never that the thing wired into it is one. What they still do
    // not reach is the wiring from `AuthService` down to the credential a fetch
    // actually uses — `auth-era-composition.test.ts` covers that end to end.
    function signedInProvider(): DefaultRequestContextProvider {
      const provider = new DefaultRequestContextProvider({
        origin: "renderer",
      });
      const user = createAuthenticatedUserFixture({});
      (user.user as { id: string }).id = "account-a";
      provider.setSignedIn({
        user,
        bearerToken: "bearer-a1",
        operationId: undefined,
        externalAbortSignal: undefined,
      });
      return provider;
    }

    it("drops the in-flight refresh on rotation (a fresh fetcher call, not a join) and fences the old bearer's late sign-out clear by the exact credential", async () => {
      const provider = signedInProvider();
      const { fetcher, callCount, resolve } = deferredFetcher();
      const directory = makeDirectory({
        authContextId: () => "account-a",
        credentialGeneration: () => provider.getCredentialGeneration(),
        runnerHost: makeHost(null),
        localHostIdSeeder: null,
        remoteFetcher: fetcher,
      });

      // Prime the directory with a legitimately loaded host so a wrongful
      // clear below is observable.
      const primed = directory.refresh();
      resolve(0, { kind: "hosts", entries: [accountAHostEntry] });
      await primed;
      expect((await directory.list()).map((entry) => entry.hostId)).toEqual([
        accountAHostEntry.hostId,
      ]);

      // The old bearer's poll goes in flight and does not resolve yet.
      const oldBearerPoll = directory.refresh();
      expect(callCount()).toBe(2);

      // Rotation: same user, new credential, through the real provider - the
      // generation moves because a bearer was replaced, not because the test
      // said so. `HostRuntime.onBearerRotated` drops the in-flight memo: a
      // joined promise from the OLD bearer must not satisfy a caller under
      // the new one.
      directory.invalidateInFlightRefresh();
      provider.rotateCurrentBearer({
        userId: "account-a",
        bearerToken: "bearer-a2",
      });

      // A refresh issued right after rotation must be a NEW fetcher call,
      // not a join onto the old bearer's dropped flight - proving the memo
      // was actually cleared, not merely rekeyed.
      const newBearerPoll = directory.refresh();
      expect(callCount()).toBe(3);
      resolve(2, { kind: "hosts", entries: [accountAHostEntry] });
      await newBearerPoll;
      expect((await directory.list()).map((entry) => entry.hostId)).toEqual([
        accountAHostEntry.hostId,
      ]);

      // The old bearer's poll NOW resolves, late, with the 401 its expired
      // token earned. The user id still matches ("account-a" throughout), so
      // a user-id-only fence would let this clear the directory the new
      // credential just legitimately filled. The credential fence must
      // discard it instead: the generation this refresh was issued under no
      // longer matches the one the rotation left behind.
      resolve(1, { kind: "signed-out" });
      await oldBearerPoll;
      expect((await directory.list()).map((entry) => entry.hostId)).toEqual([
        accountAHostEntry.hostId,
      ]);
    });

    it("does not let a caller in a NEW credential era join a request issued in the old one, even with the memo left in place", async () => {
      const provider = signedInProvider();
      const { fetcher, callCount, resolve } = deferredFetcher();
      const directory = makeDirectory({
        authContextId: () => "account-a",
        credentialGeneration: () => provider.getCredentialGeneration(),
        runnerHost: makeHost(null),
        localHostIdSeeder: null,
        remoteFetcher: fetcher,
      });

      const oldEraRefresh = directory.refresh();
      expect(callCount()).toBe(1);

      // Deliberately NOT calling `invalidateInFlightRefresh()` - that is the
      // runtime's rotation hook, and this asserts the memo KEY on its own.
      // Both guards cover this, and either alone is enough; the key is what
      // holds if a future caller reaches the directory without going through
      // the rotation listener.
      provider.rotateCurrentBearer({
        userId: "account-a",
        bearerToken: "bearer-a2",
      });

      const newEraRefresh = directory.refresh();
      expect(callCount()).toBe(2);

      resolve(0, { kind: "hosts", entries: [accountAHostEntry] });
      resolve(1, { kind: "hosts", entries: [accountAHostEntry] });
      await Promise.all([oldEraRefresh, newEraRefresh]);
    });

    it("still commits a constructive (hosts) outcome that resolves after a mid-flight rotation, when nothing newer has landed - a valid answer beats a stale directory", async () => {
      const provider = signedInProvider();
      const { fetcher, resolve } = deferredFetcher();
      const directory = makeDirectory({
        authContextId: () => "account-a",
        credentialGeneration: () => provider.getCredentialGeneration(),
        runnerHost: makeHost(null),
        localHostIdSeeder: null,
        remoteFetcher: fetcher,
      });

      // Issued under the pre-rotation generation, and deliberately NOT dropped
      // by `invalidateInFlightRefresh()` here - this is the case the asymmetry
      // is about: a rotation happens while this refresh is in flight, but it
      // still describes the right account's hosts, so it must not be fenced
      // the way a `signed-out` clear is. (The ordering watermark does not bite
      // either: no newer-generation commit has landed for it to be beneath.)
      const inFlight = directory.refresh();
      provider.rotateCurrentBearer({
        userId: "account-a",
        bearerToken: "bearer-a2",
      });
      resolve(0, { kind: "hosts", entries: [accountAHostEntry] });
      await inFlight;

      expect((await directory.list()).map((entry) => entry.hostId)).toEqual([
        accountAHostEntry.hostId,
      ]);
    });

    it("discards a constructive (hosts) outcome that resolves AFTER a newer credential's refresh already committed - reordered reads must not overwrite the newer list", async () => {
      const provider = signedInProvider();
      const { fetcher, callCount, resolve } = deferredFetcher();
      const directory = makeDirectory({
        authContextId: () => "account-a",
        credentialGeneration: () => provider.getCredentialGeneration(),
        runnerHost: makeHost(null),
        localHostIdSeeder: null,
        remoteFetcher: fetcher,
      });

      // The old bearer's poll goes in flight and stalls (a slow response is
      // all the reorder needs).
      const oldBearerPoll = directory.refresh();
      expect(callCount()).toBe(1);

      // Same-user rotation through the real provider, with the runtime's
      // rotation hook dropping the in-flight memo - the same sequence the
      // destructive-fence test drives.
      directory.invalidateInFlightRefresh();
      provider.rotateCurrentBearer({
        userId: "account-a",
        bearerToken: "bearer-a2",
      });

      // The post-rotation refresh races ahead and commits FIRST, and its list
      // is genuinely newer: a second host registered between the two reads.
      const newBearerPoll = directory.refresh();
      expect(callCount()).toBe(2);
      resolve(1, {
        kind: "hosts",
        entries: [accountAHostEntry, accountBHostEntry],
      });
      await newBearerPoll;
      expect((await directory.list()).map((entry) => entry.hostId)).toEqual([
        accountAHostEntry.hostId,
        accountBHostEntry.hostId,
      ]);

      // NOW the old bearer's read resolves - constructive, same user, but a
      // snapshot from before the newer commit. An identity-only fence lets it
      // through, silently dropping the newly registered host until the next
      // poll. The ordering watermark must discard it instead.
      resolve(0, { kind: "hosts", entries: [accountAHostEntry] });
      await oldBearerPoll;
      expect((await directory.list()).map((entry) => entry.hostId)).toEqual([
        accountAHostEntry.hostId,
        accountBHostEntry.hostId,
      ]);
    });
  });

  describe("getLocalHostId() (redesign P1.2)", () => {
    it("returns the newly re-enrolled id, not the old one, after adoptLocalHostId runs", async () => {
      const host = makeHost(localSnapshot);
      const directory = makeDirectory({
        authContextId: null,
        credentialGeneration: null,
        runnerHost: host,
        localHostIdSeeder: null,
        remoteFetcher: null,
      });
      await directory.start();
      expect(directory.getLocalHostId()).toBe(localSnapshot.hostId);

      host.setLocalHost({
        ...localSnapshot,
        hostId: "re-enrolled-host-id",
      });

      expect(directory.getLocalHostId()).toBe("re-enrolled-host-id");
      expect(directory.getLocalHostId()).not.toBe(localSnapshot.hostId);
    });
  });

  describe("registry push cadence (redesign P4.1/F22 - shell owns the registry cadence)", () => {
    it("arms NO interval of its own when the shell offers a registry push subscription - F22's one-timer deliverable", async () => {
      const { host } = makeHostWithRegistryPush(null);
      const setIntervalSpy = vi.spyOn(window, "setInterval");
      const directory = makeDirectory({
        authContextId: () => "user-a",
        credentialGeneration: null,
        runnerHost: host,
        localHostIdSeeder: null,
        remoteFetcher: () => Promise.resolve({ kind: "hosts", entries: [] }),
      });

      await directory.start();

      expect(setIntervalSpy).not.toHaveBeenCalled();
    });

    it("arms the poll interval exactly as before when the shell has no registry cadence (onRegisteredHostsChange returns null - browser/dev, and the mock shell by default)", async () => {
      const host = makeHost(null);
      const setIntervalSpy = vi.spyOn(window, "setInterval");
      const directory = makeDirectory({
        authContextId: null,
        credentialGeneration: null,
        runnerHost: host,
        localHostIdSeeder: null,
        remoteFetcher: () => Promise.resolve({ kind: "hosts", entries: [] }),
      });

      await directory.start();

      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    });

    it("a push with a MATCHING identityKey drives both refresh() and onRegistryPollTick()", async () => {
      const { host, push } = makeHostWithRegistryPush(null);
      let fetchCalls = 0;
      const fetcher: RemoteHostFetcher = () => {
        fetchCalls += 1;
        return Promise.resolve({ kind: "hosts", entries: [] });
      };
      const onRegistryPollTick = vi.fn();
      const directory = makeDirectory({
        authContextId: () => "user-a",
        credentialGeneration: null,
        runnerHost: host,
        localHostIdSeeder: null,
        remoteFetcher: fetcher,
        onRegistryPollTick,
      });
      await directory.start();
      const fetchCallsAfterStart = fetchCalls;

      push({ identityKey: "user-a", response: { hosts: [] } });
      await flushPromises();

      expect(fetchCalls).toBe(fetchCallsAfterStart + 1);
      expect(onRegistryPollTick).toHaveBeenCalledTimes(1);
    });

    it("a push arriving while the window is HIDDEN is held, and acted on once when the window becomes visible", async () => {
      // The push path returned from `start()` before `visibilityDocument` was
      // assigned, so `isDocumentHidden()` was permanently false on desktop and
      // every background window refetched `GET /api/v3/hosts` on each of
      // main's ticks - the fetch the removed per-window timer used to skip.
      const { host, push } = makeHostWithRegistryPush(null);
      let fetchCalls = 0;
      const fetcher: RemoteHostFetcher = () => {
        fetchCalls += 1;
        return Promise.resolve({ kind: "hosts", entries: [] });
      };
      const onRegistryPollTick = vi.fn();
      const directory = makeDirectory({
        authContextId: () => "user-a",
        credentialGeneration: null,
        runnerHost: host,
        localHostIdSeeder: null,
        remoteFetcher: fetcher,
        onRegistryPollTick,
      });
      await directory.start();
      const fetchCallsAfterStart = fetchCalls;

      setDocumentHidden(true);
      push({ identityKey: "user-a", response: { hosts: [] } });
      push({ identityKey: "user-a", response: { hosts: [] } });
      await flushPromises();
      // Nothing while hidden.
      expect(fetchCalls).toBe(fetchCallsAfterStart);
      expect(onRegistryPollTick).not.toHaveBeenCalled();

      // Resume: ONE catch-up, not one per missed push.
      setDocumentHidden(false);
      document.dispatchEvent(new Event("visibilitychange"));
      await flushPromises();
      expect(fetchCalls).toBe(fetchCallsAfterStart + 1);
      expect(onRegistryPollTick).toHaveBeenCalledTimes(1);

      // A resume with nothing missed does nothing.
      document.dispatchEvent(new Event("visibilitychange"));
      await flushPromises();
      expect(fetchCalls).toBe(fetchCallsAfterStart + 1);
    });

    it("a push whose identityKey does NOT match authContextId() drives NEITHER refresh() nor onRegistryPollTick() (cross-account fence)", async () => {
      const { host, push } = makeHostWithRegistryPush(null);
      let fetchCalls = 0;
      const fetcher: RemoteHostFetcher = () => {
        fetchCalls += 1;
        return Promise.resolve({ kind: "hosts", entries: [] });
      };
      const onRegistryPollTick = vi.fn();
      const directory = makeDirectory({
        authContextId: () => "user-a",
        credentialGeneration: null,
        runnerHost: host,
        localHostIdSeeder: null,
        remoteFetcher: fetcher,
        onRegistryPollTick,
      });
      await directory.start();
      const fetchCallsAfterStart = fetchCalls;

      push({ identityKey: "user-b", response: { hosts: [] } });
      await flushPromises();

      expect(fetchCalls).toBe(fetchCallsAfterStart);
      expect(onRegistryPollTick).not.toHaveBeenCalled();
    });

    it("a push with identityKey: null while signed out (authContextId() returns null) IS accepted - null is a real account state, not unknown", async () => {
      const { host, push } = makeHostWithRegistryPush(null);
      let fetchCalls = 0;
      const fetcher: RemoteHostFetcher = () => {
        fetchCalls += 1;
        return Promise.resolve({ kind: "signed-out" });
      };
      const onRegistryPollTick = vi.fn();
      const directory = makeDirectory({
        authContextId: () => null,
        credentialGeneration: null,
        runnerHost: host,
        localHostIdSeeder: null,
        remoteFetcher: fetcher,
        onRegistryPollTick,
      });
      await directory.start();
      const fetchCallsAfterStart = fetchCalls;

      push({ identityKey: null, response: { hosts: [] } });
      await flushPromises();

      expect(fetchCalls).toBe(fetchCallsAfterStart + 1);
      expect(onRegistryPollTick).toHaveBeenCalledTimes(1);
    });

    it("dispose() disposes the shell registry-push subscription", async () => {
      const { host, disposeCount } = makeHostWithRegistryPush(null);
      const directory = makeDirectory({
        authContextId: null,
        credentialGeneration: null,
        runnerHost: host,
        localHostIdSeeder: null,
        remoteFetcher: () => Promise.resolve({ kind: "hosts", entries: [] }),
      });
      await directory.start();
      expect(disposeCount()).toBe(0);

      directory.dispose();

      expect(disposeCount()).toBe(1);
    });
  });
});

/**
 * Boot-ordering convergence (int #48).
 *
 * The 2026-08-11 lock was not reproducible on demand: one launch of the same
 * install came up locked and STAYED locked through a renderer reload, the next
 * came up clean. That is the signature of a startup race whose bad outcome
 * LATCHES - and the latch here is an ask that happens exactly once.
 *
 * `start()` asks the shell for this machine's durable host id a single time.
 * The ask crosses an IPC boundary with `retry: false`, its answer is cacheable
 * for a minute, and on a fresh profile there is no persisted fallback - so
 * `null` is an ordinary outcome, and it used to be permanent for the life of
 * the app instance. A null id means `snapshot()` cannot recognise the
 * registry's twin of this machine, so the twin is published verbatim:
 * `kind: "remote"`, relay URL, and whatever its presence lease says. Right
 * after the host was down - precisely when this path runs - that lease reads
 * expired, and the row for the user's own working machine is a remote host
 * marked unavailable. Every chat it owns locks to a published copy, and
 * nothing re-asks.
 *
 * These tests pin CONVERGENCE rather than ordering: whichever input is late,
 * the directory has to arrive at the truth on its own.
 */
describe("HostDirectoryService boot-ordering convergence", () => {
  const LOCAL_HOST_ID = "desktop-pid-123";

  /** The registry's view of THIS machine while its host is down. */
  const expiredOwnTwin: HostDirectoryEntry = {
    hostId: LOCAL_HOST_ID,
    label: "hardiks-macbook",
    kind: "remote",
    websocketUrl: "wss://relay.traycer.invalid/attach",
    version: "1.2.3",
    transportDialability: "not-dialable",
  };

  it("re-asks for this machine's id when the first ask came back null, and stops claiming its own host is a dead remote", async () => {
    // The shell cannot answer yet (host still booting, or the IPC query
    // resolved null and cached it).
    let shellHostId: string | null = null;
    const directory = makeDirectory({
      authContextId: null,
      credentialGeneration: null,
      runnerHost: makeHost(null),
      remoteFetcher: (): Promise<RemoteHostFetchOutcome> =>
        Promise.resolve({ kind: "hosts", entries: [expiredOwnTwin] }),
      localHostIdSeeder: () => Promise.resolve(shellHostId),
    });

    await directory.start();

    // The latched state: our own machine, presented as an unavailable REMOTE
    // row. Both of `useHostReachability`'s protections miss this shape - the
    // directory is not empty, and the row is not a local one - so it reports
    // `unreachable` and locks the user's chats.
    const beforeReseed = await directory.list();
    expect(beforeReseed).toHaveLength(1);
    expect(beforeReseed[0].kind).toBe("remote");
    expect(beforeReseed[0].transportDialability).toBe("not-dialable");

    // The shell can answer now. Nothing else about the world changed - no new
    // snapshot, no registry change - so only a re-ask can converge this.
    shellHostId = LOCAL_HOST_ID;
    await directory.refresh();

    const afterReseed = await directory.list();
    expect(afterReseed).toHaveLength(1);
    // Recognised as this machine: non-dialable (so nothing can reach for the
    // relay against our own host) and LOCAL, which is the shape
    // `useHostReachability` reads as "not published yet" rather than "dead",
    // and which keeps the local provisioning lifecycle armed.
    expect(afterReseed[0].kind).toBe("local");
    expect(afterReseed[0].websocketUrl).toBeNull();
  });

  it("stops re-asking once the id is known", async () => {
    const seeder = vi.fn(() => Promise.resolve(LOCAL_HOST_ID));
    const directory = makeDirectory({
      authContextId: null,
      credentialGeneration: null,
      runnerHost: makeHost(null),
      remoteFetcher: (): Promise<RemoteHostFetchOutcome> =>
        Promise.resolve({ kind: "hosts", entries: [expiredOwnTwin] }),
      localHostIdSeeder: seeder,
    });

    await directory.start();
    const asksAfterStart = seeder.mock.calls.length;
    await directory.refresh();
    await directory.refresh();

    // Self-retiring: the repair costs one ask, not one per poll forever.
    expect(seeder.mock.calls.length).toBe(asksAfterStart);
  });

  it("converges to the live local host whenever its snapshot finally arrives", async () => {
    const host = makeHost(null);
    const directory = makeDirectory({
      authContextId: null,
      credentialGeneration: null,
      runnerHost: host,
      remoteFetcher: (): Promise<RemoteHostFetchOutcome> =>
        Promise.resolve({ kind: "hosts", entries: [expiredOwnTwin] }),
      localHostIdSeeder: () => Promise.resolve(LOCAL_HOST_ID),
    });

    await directory.start();
    expect((await directory.list())[0].websocketUrl).toBeNull();

    // Late arrival - the case the whole ticket is about. The local arm must
    // win over the registry twin and the row must become dialable.
    host.setLocalHost(localSnapshot);

    const converged = await directory.list();
    expect(converged).toHaveLength(1);
    expect(converged[0]).toMatchObject({
      hostId: LOCAL_HOST_ID,
      kind: "local",
      transportDialability: "dialable",
      websocketUrl: localSnapshot.websocketUrl,
    });
  });

  it("projects a busy shell verdict into a DIALABLE local entry", async () => {
    // A host that lost a probe is still the host: dialable URL, `busy`
    // availability. Publishing it as anything else is what put the registry
    // twin - and its hardcoded `unavailable` - in front of the user in the
    // first place.
    //
    // The entry no longer carries the shell's three-valued availability; it
    // carries the projection (`toLocalEntry`), which is the one seam where a
    // `HostAvailability` becomes a `HostTransportDialability`. Pinning it here
    // is what keeps `busy` from ever reaching a consumer as death: every
    // downstream reason (`hostUnavailability`) derives from this field.
    const host = makeHost(null);
    const directory = makeDirectory({
      authContextId: null,
      credentialGeneration: null,
      runnerHost: host,
      remoteFetcher: (): Promise<RemoteHostFetchOutcome> =>
        Promise.resolve({ kind: "hosts", entries: [] }),
      localHostIdSeeder: () => Promise.resolve(LOCAL_HOST_ID),
    });
    await directory.start();

    host.setLocalHost({ ...localSnapshot, availability: "busy" });

    expect((await directory.list())[0]).toMatchObject({
      kind: "local",
      transportDialability: "dialable",
      websocketUrl: localSnapshot.websocketUrl,
    });
  });
});
