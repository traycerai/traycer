import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DefaultRequestContextProvider } from "@traycer-clients/shared/auth/request-context-provider";
import { createAuthenticatedUserFixture } from "@traycer-clients/shared/test-fixtures/authenticated-user";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { mockRemoteHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import type { LocalHostSnapshot } from "@traycer-clients/shared/platform/runner-host";
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
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { lastLocalHostIdKey, lastSelectedHostKey } from "@/lib/persist";
import { useSettingsHostScopeStore } from "@/stores/settings/settings-host-scope-store";

const toastInfo = vi.hoisted(() => vi.fn());

// Failover / re-adopt announce through sonner. The mock must not throw for any
// other path that imports the service - existing suites never assert on toast.
// `error` and `warning` are stubbed too, not just `info`: this suite reaches
// `reportable-error-toast.ts`, which calls both, and a whole-module factory
// replaces sonner entirely - so an exercised failure path would die on
// `toast.error is not a function` rather than on its own assertion.
vi.mock("sonner", () => ({
  toast: {
    info: (...args: unknown[]) => {
      toastInfo(...args);
    },
    error: () => undefined,
    warning: () => undefined,
  },
}));

/**
 * Controllable ready-session evidence, mirroring the seam
 * `use-host-reachability.composition.test.tsx` already uses. The service's
 * death gate (`isConfirmedHostDeath`) honours a ready live session as
 * firsthand proof of life; after the cold review's P1 correction that dial
 * outcome - never `lastSeenAt` recency - is the ONLY thing that suppresses
 * failover for an `offline` selection inside the relay-fuse window. Partial
 * (spread-actual) so every other export stays real.
 */
const readySessionHosts = vi.hoisted(() => ({ value: new Set<string>() }));

vi.mock(
  "@traycer-clients/shared/host-transport/remote/index",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer-clients/shared/host-transport/remote/index")
      >();
    return {
      ...actual,
      hasReadyRemoteSession: (hostId: string) =>
        readySessionHosts.value.has(hostId),
    };
  },
);

afterEach(() => {
  readySessionHosts.value.clear();
});

// Matches the production constant of the same name in `host-directory-service.ts`
// — the app's ONE background cadence for `GET /api/v3/hosts`, moved from 15s to
// 60s to actually match the Settings observer's poll (see that file's comment).
const HOST_DIRECTORY_REFRESH_POLL_MS = 60_000;
const LAST_SELECTED_HOST_STORAGE_KEY = lastSelectedHostKey();
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

const localSnapshotNewEndpoint: LocalHostSnapshot = {
  ...localSnapshot,
  websocketUrl: "ws://127.0.0.1:4918/rpc",
  pid: 4243,
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

/** A third dialable remote, for the case where BOTH failover ends vanish. */
const thirdRemoteHostEntry: HostDirectoryEntry = {
  hostId: "third-remote-host",
  label: "Third Remote",
  kind: "remote",
  websocketUrl: "wss://third-remote.traycer.invalid/rpc",
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

const directories: HostDirectoryService[] = [];
let restoreDocumentHidden: (() => void) | null = null;

function makeDirectory(
  options: HostDirectoryServiceOptions,
): HostDirectoryService {
  const directory = new HostDirectoryService(options);
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

function rememberHostSelection(hostId: string): void {
  window.localStorage.setItem(LAST_SELECTED_HOST_STORAGE_KEY, hostId);
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  window.localStorage.removeItem(LAST_SELECTED_HOST_STORAGE_KEY);
  window.localStorage.removeItem(LAST_LOCAL_HOST_ID_STORAGE_KEY);
});

afterEach(() => {
  for (const directory of directories.splice(0)) {
    directory.dispose();
  }
  window.localStorage.removeItem(LAST_SELECTED_HOST_STORAGE_KEY);
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
    expect(directory.getSelected()).toBeNull();
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

  it("emits onSelectionChange after selectById()", async () => {
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

    const observed: Array<HostDirectoryEntry | null> = [];
    directory.onSelectionChange((entry) => {
      observed.push(entry);
    });

    directory.selectById(mockRemoteHostEntry.hostId);
    directory.selectById(null);

    expect(observed).toHaveLength(2);
    expect(observed[0]?.hostId).toBe(mockRemoteHostEntry.hostId);
    expect(observed[1]).toBeNull();
  });

  it("persists explicit host selection gestures including clear", async () => {
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

    directory.selectById(mockRemoteHostEntry.hostId);
    expect(window.localStorage.getItem(LAST_SELECTED_HOST_STORAGE_KEY)).toBe(
      mockRemoteHostEntry.hostId,
    );

    directory.selectById(null);
    expect(
      window.localStorage.getItem(LAST_SELECTED_HOST_STORAGE_KEY),
    ).toBeNull();
  });

  it("restores the persisted host during startup before local default-promotion can bind", async () => {
    rememberHostSelection(rememberedRemoteHostEntry.hostId);
    const host = makeHost(localSnapshot);
    const directory = makeDirectory({
      authContextId: null,
      credentialGeneration: null,
      runnerHost: host,
      localHostIdSeeder: null,
      remoteFetcher: () =>
        Promise.resolve({
          kind: "hosts",
          entries: [rememberedRemoteHostEntry, mockRemoteHostEntry],
        }),
    });

    await directory.start();

    expect(directory.getSelected()?.hostId).toBe(
      rememberedRemoteHostEntry.hostId,
    );
    expect(directory.getSelected()?.kind).toBe("remote");
  });

  it("falls back to the local default synchronously with initial refresh when the persisted host is absent", async () => {
    rememberHostSelection("offline-remembered-host");
    const host = makeHost(localSnapshot);
    const pending: {
      resolve: ((outcome: RemoteHostFetchOutcome) => void) | null;
    } = { resolve: null };
    const fetcher: RemoteHostFetcher = () =>
      new Promise<RemoteHostFetchOutcome>((resolve) => {
        pending.resolve = resolve;
      });
    const directory = makeDirectory({
      authContextId: null,
      credentialGeneration: null,
      runnerHost: host,
      localHostIdSeeder: null,
      remoteFetcher: fetcher,
    });

    const startPromise = directory.start();
    // `start()` first settles the shell's durable local-host-id seed, so the
    // initial fetch is dispatched one hop in rather than synchronously. The
    // property under test is unchanged: a remote fetch still in flight must
    // not hold back the local default.
    await flushPromises();
    expect(directory.getSelected()).toBeNull();

    pending.resolve?.({ kind: "hosts", entries: [] });
    await startPromise;

    expect(directory.getSelected()?.hostId).toBe(localSnapshot.hostId);
  });

  it("does not switch to a late-arriving persisted host after startup fell back to the local default", async () => {
    rememberHostSelection(rememberedRemoteHostEntry.hostId);
    const host = makeHost(localSnapshot);
    const { fetcher } = queuedFetcher([
      { kind: "hosts", entries: [] },
      { kind: "hosts", entries: [rememberedRemoteHostEntry] },
    ]);
    const directory = makeDirectory({
      authContextId: null,
      credentialGeneration: null,
      runnerHost: host,
      localHostIdSeeder: null,
      remoteFetcher: fetcher,
    });

    await directory.start();
    expect(directory.getSelected()?.hostId).toBe(localSnapshot.hostId);

    const observed: Array<HostDirectoryEntry | null> = [];
    directory.onSelectionChange((entry) => {
      observed.push(entry);
    });

    await directory.refresh();

    expect(directory.getSelected()?.hostId).toBe(localSnapshot.hostId);
    expect(observed).toEqual([]);
  });

  it("uses one post-startup restore attempt when a no-local shell remains unbound", async () => {
    rememberHostSelection(rememberedRemoteHostEntry.hostId);
    const host = makeHost(null);
    const { fetcher } = queuedFetcher([
      { kind: "hosts", entries: [] },
      {
        kind: "hosts",
        entries: [rememberedRemoteHostEntry, secondRemoteHostEntry],
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
    expect(directory.getSelected()).toBeNull();

    const observed: Array<HostDirectoryEntry | null> = [];
    directory.onSelectionChange((entry) => {
      observed.push(entry);
    });

    await directory.refresh();

    expect(directory.getSelected()?.hostId).toBe(
      rememberedRemoteHostEntry.hostId,
    );
    expect(observed.map((entry) => entry?.hostId ?? null)).toEqual([
      rememberedRemoteHostEntry.hostId,
    ]);
  });

  it("keeps the no-local post-startup restore attempt armed across a near-miss delivery, then consumes it on an actual match", async () => {
    rememberHostSelection(rememberedRemoteHostEntry.hostId);
    const host = makeHost(null);
    const { fetcher } = queuedFetcher([
      { kind: "hosts", entries: [] },
      {
        kind: "hosts",
        entries: [mockRemoteHostEntry, secondRemoteHostEntry],
      },
      {
        kind: "hosts",
        entries: [rememberedRemoteHostEntry, secondRemoteHostEntry],
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
    // A delivery that doesn't contain the remembered host must not burn the
    // one-shot - it stays armed for a later delivery that does.
    await directory.refresh();
    expect(directory.getSelected()).toBeNull();

    await directory.refresh();

    expect(directory.getSelected()?.hostId).toBe(
      rememberedRemoteHostEntry.hostId,
    );
  });

  it("keeps the persisted remote selection armed across a FAILED first refresh - the next successful refresh restores it over the promoted local default", async () => {
    rememberHostSelection(rememberedRemoteHostEntry.hostId);
    const host = makeHost(localSnapshot);
    const { fetcher } = queuedFetcher([
      { kind: "failed" },
      { kind: "hosts", entries: [rememberedRemoteHostEntry] },
    ]);
    const directory = makeDirectory({
      authContextId: null,
      credentialGeneration: null,
      runnerHost: host,
      localHostIdSeeder: null,
      remoteFetcher: fetcher,
    });

    await directory.start();
    // A transient blip must not strand the app: the local default is
    // promoted for usability while the restore intent stays armed.
    expect(directory.getSelected()?.hostId).toBe(localSnapshot.hostId);

    await directory.refresh();

    // The first refresh that genuinely resolves re-binds the user's
    // remembered remote host - a network blip at launch never consumed it.
    expect(directory.getSelected()?.hostId).toBe(
      rememberedRemoteHostEntry.hostId,
    );
    expect(directory.getSelected()?.kind).toBe("remote");
  });

  it("retires the failed-first-refresh restore on the first GENUINE refresh that omits the host - the deregistered case falls to the default for good", async () => {
    rememberHostSelection(rememberedRemoteHostEntry.hostId);
    const host = makeHost(localSnapshot);
    const { fetcher } = queuedFetcher([
      { kind: "failed" },
      { kind: "hosts", entries: [] },
      { kind: "hosts", entries: [rememberedRemoteHostEntry] },
    ]);
    const directory = makeDirectory({
      authContextId: null,
      credentialGeneration: null,
      runnerHost: host,
      localHostIdSeeder: null,
      remoteFetcher: fetcher,
    });

    await directory.start();
    expect(directory.getSelected()?.hostId).toBe(localSnapshot.hostId);

    // A genuine result WITHOUT the remembered host settles it exactly as a
    // genuine first refresh would have: fall to the default, retire the
    // intent.
    await directory.refresh();
    expect(directory.getSelected()?.hostId).toBe(localSnapshot.hostId);

    // A later re-appearance must NOT yank the user anymore (pins parity with
    // the genuine-first-refresh late-arrival behavior above).
    await directory.refresh();
    expect(directory.getSelected()?.hostId).toBe(localSnapshot.hostId);
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
    expect(directory.getSelected()?.hostId).toBe(localSnapshot.hostId);

    // The service is fully operational afterwards: the next refresh merges
    // the remote entries as usual.
    const entries = await directory.refresh();
    expect(entries.map((entry) => entry.hostId)).toContain(
      rememberedRemoteHostEntry.hostId,
    );
  });

  it("clears stale selection when the selected host is no longer in the directory", async () => {
    const host = makeHost(localSnapshot);
    const directory = makeDirectory({
      authContextId: null,
      credentialGeneration: null,
      runnerHost: host,
      localHostIdSeeder: null,
      remoteFetcher: null,
    });
    await directory.start();

    directory.selectById(localSnapshot.hostId);
    expect(directory.getSelected()?.hostId).toBe(localSnapshot.hostId);

    host.setLocalHost(null);
    expect(directory.getSelected()).toBeNull();
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

  it("emits a fresh selected local entry when the same host id changes endpoint", async () => {
    const host = makeHost(localSnapshot);
    const directory = makeDirectory({
      authContextId: null,
      credentialGeneration: null,
      runnerHost: host,
      localHostIdSeeder: null,
      remoteFetcher: null,
    });
    await directory.start();

    const selectedBefore = directory.getSelected();
    expect(selectedBefore?.hostId).toBe(localSnapshot.hostId);

    const observed: Array<HostDirectoryEntry | null> = [];
    directory.onSelectionChange((entry) => {
      observed.push(entry);
    });

    host.setLocalHost(localSnapshotNewEndpoint);

    expect(observed).toHaveLength(1);
    expect(observed[0]?.hostId).toBe(localSnapshot.hostId);
    expect(observed[0]?.websocketUrl).toBe(
      localSnapshotNewEndpoint.websocketUrl,
    );
    expect(observed[0]).not.toBe(selectedBefore);
    expect(directory.getSelected()?.websocketUrl).toBe(
      localSnapshotNewEndpoint.websocketUrl,
    );
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

  it("auto-promotes a later-arriving local host to the effective selection and fires onSelectionChange", async () => {
    // Regression for the signed-in startup path:
    //   1. GUI mounts before any local-host snapshot is available.
    //   2. `HostRuntime.start()` reads `getSelected()` → null, binds null,
    //      then subscribes to `onSelectionChange(...)`.
    //   3. The local host appears later via the runner host.
    // The directory must promote that entry into the effective selection and
    // fire `onSelectionChange(...)` so the runtime rebinds without a remount.
    const host = makeHost(null);
    const directory = makeDirectory({
      authContextId: null,
      credentialGeneration: null,
      runnerHost: host,
      localHostIdSeeder: null,
      remoteFetcher: null,
    });
    await directory.start();

    expect(directory.getSelected()).toBeNull();

    const observed: Array<HostDirectoryEntry | null> = [];
    directory.onSelectionChange((entry) => {
      observed.push(entry);
    });

    host.setLocalHost(localSnapshot);

    expect(observed).toHaveLength(1);
    expect(observed[0]?.hostId).toBe(localSnapshot.hostId);
    expect(observed[0]?.kind).toBe("local");
    expect(directory.getSelected()?.hostId).toBe(localSnapshot.hostId);
  });

  it("preserves an explicit non-null selection when the local host appears later", async () => {
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

    directory.selectById(mockRemoteHostEntry.hostId);

    const observed: Array<HostDirectoryEntry | null> = [];
    directory.onSelectionChange((entry) => {
      observed.push(entry);
    });

    host.setLocalHost(localSnapshot);

    expect(observed).toHaveLength(0);
    expect(directory.getSelected()?.hostId).toBe(mockRemoteHostEntry.hostId);
  });

  it("does not re-auto-bind after an explicit selectById(null) when a default entry is available", async () => {
    // Explicit user-clear must remain user-cleared: after `selectById(null)`
    // the service must not silently re-promote the local default. The startup
    // auto-bind only runs when the user has made no explicit selection yet.
    const host = makeHost(null);
    const directory = makeDirectory({
      authContextId: null,
      credentialGeneration: null,
      runnerHost: host,
      localHostIdSeeder: null,
      remoteFetcher: null,
    });
    await directory.start();

    host.setLocalHost(localSnapshot);
    expect(directory.getSelected()?.hostId).toBe(localSnapshot.hostId);

    const observed: Array<HostDirectoryEntry | null> = [];
    directory.onSelectionChange((entry) => {
      observed.push(entry);
    });

    directory.selectById(null);
    expect(observed).toEqual([null]);

    // A subsequent refresh must not re-promote the still-available local
    // default back into the selection - the user explicitly cleared it.
    await directory.refresh();
    expect(observed).toEqual([null]);
    expect(directory.getSelected()).toBeNull();
  });

  it("does not fall back to another host while an explicit selected host is offline", async () => {
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

    directory.selectById(localSnapshot.hostId);
    expect(directory.getSelected()?.hostId).toBe(localSnapshot.hostId);

    const observed: Array<HostDirectoryEntry | null> = [];
    directory.onSelectionChange((entry) => {
      observed.push(entry);
    });

    host.setLocalHost(null);

    expect(observed).toEqual([null]);
    expect(directory.getSelected()).toBeNull();

    host.setLocalHost(localSnapshotNewEndpoint);

    expect(observed.map((entry) => entry?.hostId ?? null)).toEqual([
      null,
      localSnapshot.hostId,
    ]);
    expect(directory.getSelected()?.websocketUrl).toBe(
      localSnapshotNewEndpoint.websocketUrl,
    );
  });

  it("restores an explicitly selected host when the same id returns after going offline", async () => {
    const host = makeHost(localSnapshot);
    const directory = makeDirectory({
      authContextId: null,
      credentialGeneration: null,
      runnerHost: host,
      localHostIdSeeder: null,
      remoteFetcher: null,
    });
    await directory.start();

    directory.selectById(localSnapshot.hostId);
    expect(directory.getSelected()?.hostId).toBe(localSnapshot.hostId);

    const observed: Array<HostDirectoryEntry | null> = [];
    directory.onSelectionChange((entry) => {
      observed.push(entry);
    });

    host.setLocalHost(null);
    host.setLocalHost(localSnapshotNewEndpoint);

    expect(observed.map((entry) => entry?.hostId ?? null)).toEqual([
      null,
      localSnapshot.hostId,
    ]);
    expect(directory.getSelected()?.websocketUrl).toBe(
      localSnapshotNewEndpoint.websocketUrl,
    );
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

  it("does not reassign or notify onSelectionChange when a poll delivers a field-identical remote entry for the bound selection", async () => {
    const host = makeHost(null);
    const { fetcher } = queuedFetcher([
      { kind: "hosts", entries: [mockRemoteHostEntry] },
      // A fresh object literal, byte-identical to `mockRemoteHostEntry` but a
      // different reference - exactly what a real poll fetch produces even
      // when nothing about the host actually changed.
      { kind: "hosts", entries: [{ ...mockRemoteHostEntry }] },
    ]);
    const directory = makeDirectory({
      authContextId: null,
      credentialGeneration: null,
      runnerHost: host,
      localHostIdSeeder: null,
      remoteFetcher: fetcher,
    });
    await directory.start();
    expect(directory.getSelected()?.hostId).toBe(mockRemoteHostEntry.hostId);
    const boundEntry = directory.getSelected();

    const observed: Array<HostDirectoryEntry | null> = [];
    directory.onSelectionChange((entry) => {
      observed.push(entry);
    });

    await directory.refresh();

    expect(directory.getSelected()).toBe(boundEntry);
    expect(observed).toEqual([]);
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
    );
    nowSpy.mockReturnValue(lastSeenMs + RELAY_FUSE_MAX_ATTACH_MS + 1);
    const aged = hostListItemToDirectoryEntry(
      item,
      "wss://relay.example.test/attach",
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

  it("retains the last-known remote entries and selection when a refresh fails (T20 / audit P4)", async () => {
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
    expect(directory.getSelected()?.hostId).toBe(mockRemoteHostEntry.hostId);

    const observed: Array<HostDirectoryEntry | null> = [];
    directory.onSelectionChange((entry) => {
      observed.push(entry);
    });

    await directory.refresh();

    expect(await directory.list()).toHaveLength(1);
    expect(directory.getSelected()?.hostId).toBe(mockRemoteHostEntry.hostId);
    expect(observed).toEqual([]);
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

  it("keeps an explicitly selected remote host bound through a failed refresh, with no onSelectionChange(null)", async () => {
    const host = makeHost(null);
    const secondRemote: HostDirectoryEntry = {
      hostId: "mock-remote-2",
      label: "Second Remote",
      kind: "remote",
      websocketUrl: "wss://mock-remote-2.traycer.invalid/rpc",
      version: "0.0.0-mock",
      transportDialability: "dialable",
    };
    const { fetcher } = queuedFetcher([
      { kind: "hosts", entries: [mockRemoteHostEntry, secondRemote] },
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
    directory.selectById(secondRemote.hostId);
    expect(directory.getSelected()?.hostId).toBe(secondRemote.hostId);

    const observed: Array<HostDirectoryEntry | null> = [];
    directory.onSelectionChange((entry) => {
      observed.push(entry);
    });

    await directory.refresh();

    expect(directory.getSelected()?.hostId).toBe(secondRemote.hostId);
    expect(observed).toEqual([]);
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

  /**
   * A transient activation (today: a native notification whose row was minted
   * on another host) has to move the app WITHOUT claiming the user picked
   * that host. Same binding authority, no durable intent - which is exactly
   * what makes it recoverable when that host goes away.
   */
  describe("selectTransientById", () => {
    it("binds through the same selection listener as an explicit pick", async () => {
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

      const observed: Array<HostDirectoryEntry | null> = [];
      directory.onSelectionChange((entry) => {
        observed.push(entry);
      });

      directory.selectTransientById(mockRemoteHostEntry.hostId, "notification");

      expect(observed.map((entry) => entry?.hostId ?? null)).toEqual([
        mockRemoteHostEntry.hostId,
      ]);
      expect(directory.getSelected()?.hostId).toBe(mockRemoteHostEntry.hostId);
    });

    it("hands back to the default host when the activated entry leaves the directory", async () => {
      // The whole point of the transient seam. `selectById` would have pinned
      // `explicitSelection` here, and the app would sit unbound for the rest
      // of the session with a perfectly good local host in the directory.
      const host = makeHost(localSnapshot);
      let remotes: readonly HostDirectoryEntry[] = [mockRemoteHostEntry];
      const directory = makeDirectory({
        authContextId: null,
        credentialGeneration: null,
        runnerHost: host,
        localHostIdSeeder: null,
        remoteFetcher: () =>
          Promise.resolve({ kind: "hosts", entries: remotes }),
      });
      await directory.start();

      directory.selectTransientById(mockRemoteHostEntry.hostId, "notification");
      expect(directory.getSelected()?.hostId).toBe(mockRemoteHostEntry.hostId);

      const observed: Array<HostDirectoryEntry | null> = [];
      directory.onSelectionChange((entry) => {
        observed.push(entry);
      });

      remotes = [];
      await directory.refresh();

      // One transition, straight to the default - not an unbind followed by a
      // later re-promotion, which would flap the app-wide host binding.
      expect(observed.map((entry) => entry?.hostId ?? null)).toEqual([
        localSnapshot.hostId,
      ]);
      expect(directory.getSelected()?.hostId).toBe(localSnapshot.hostId);
    });

    it("keeps an explicit pick pinned when ITS host leaves the directory", async () => {
      // The contrast case, asserted so the transient seam cannot be
      // generalised into "always fall back": a user who chose a host is not
      // silently moved to another one.
      const host = makeHost(localSnapshot);
      let remotes: readonly HostDirectoryEntry[] = [mockRemoteHostEntry];
      const directory = makeDirectory({
        authContextId: null,
        credentialGeneration: null,
        runnerHost: host,
        localHostIdSeeder: null,
        remoteFetcher: () =>
          Promise.resolve({ kind: "hosts", entries: remotes }),
      });
      await directory.start();

      directory.selectById(mockRemoteHostEntry.hostId);
      remotes = [];
      await directory.refresh();

      expect(directory.getSelected()).toBeNull();
    });

    it("is a no-op for an id the directory does not hold, never an unbind", async () => {
      const host = makeHost(localSnapshot);
      const directory = makeDirectory({
        authContextId: null,
        credentialGeneration: null,
        runnerHost: host,
        localHostIdSeeder: null,
        remoteFetcher: null,
      });
      await directory.start();
      expect(directory.getSelected()?.hostId).toBe(localSnapshot.hostId);

      const observed: Array<HostDirectoryEntry | null> = [];
      directory.onSelectionChange((entry) => {
        observed.push(entry);
      });

      directory.selectTransientById("host-that-left", "notification");

      expect(observed).toEqual([]);
      expect(directory.getSelected()?.hostId).toBe(localSnapshot.hostId);
    });

    it("attributes the selection to the caller's analytics source", async () => {
      const track = vi.spyOn(Analytics.getInstance(), "track");
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

      directory.selectTransientById(mockRemoteHostEntry.hostId, "notification");
      directory.selectById(localSnapshot.hostId);

      expect(
        track.mock.calls.filter(
          (call) => call[0] === AnalyticsEvent.HostSelected,
        ),
      ).toEqual([
        [
          AnalyticsEvent.HostSelected,
          { source: "notification", host_kind: "remote" },
        ],
        [
          AnalyticsEvent.HostSelected,
          { source: "direct_ui", host_kind: "local" },
        ],
      ]);
    });
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

    it("restores the remembered local selection onto the booting entry rather than dropping it", async () => {
      window.localStorage.setItem(
        LAST_LOCAL_HOST_ID_STORAGE_KEY,
        localSnapshot.hostId,
      );
      rememberHostSelection(localSnapshot.hostId);
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

      const selected = directory.getSelected();
      expect(selected?.hostId).toBe(localSnapshot.hostId);
      expect(selected?.kind).toBe("local");
      expect(selected?.websocketUrl).toBeNull();
    });

    /**
     * Regression (Codex P1 on OSS #913): when the twin was DROPPED instead of
     * coerced, the remembered local id resolved to nothing at startup, so a
     * registry holding exactly one other machine had that remote auto-promoted
     * as the default - and `reconcileSelection()` returns early while the
     * current selection is still present, so the app stayed bound to the wrong
     * machine even after the local host came back.
     */
    it("never promotes a lone remote over this machine's booting host", async () => {
      window.localStorage.setItem(
        LAST_LOCAL_HOST_ID_STORAGE_KEY,
        localSnapshot.hostId,
      );
      rememberHostSelection(localSnapshot.hostId);
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

      expect(directory.getSelected()?.hostId).toBe(localSnapshot.hostId);

      // ...and once the local host publishes, the selection follows it to the
      // real dialable endpoint instead of being stranded on the remote.
      host.setLocalHost(localSnapshot);

      const selected = directory.getSelected();
      expect(selected?.hostId).toBe(localSnapshot.hostId);
      expect(selected?.kind).toBe("local");
      expect(selected?.websocketUrl).toBe(localSnapshot.websocketUrl);
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

    /**
     * Regression (Codex P1 on OSS #913): the id is not the only holder of
     * "this machine". The persisted SELECTION can carry the pre-re-enrollment
     * id, and startup would restore the obsolete registry twin as a valid
     * remote selection - stranding the app on a dead relay target with local
     * provisioning disabled. The selection intent must migrate with the id.
     */
    it("migrates a remembered selection of the old local id to the re-enrolled one", async () => {
      window.localStorage.setItem(
        LAST_LOCAL_HOST_ID_STORAGE_KEY,
        "stale-host-id-from-a-previous-enrollment",
      );
      rememberHostSelection("stale-host-id-from-a-previous-enrollment");
      const obsoleteTwin: HostDirectoryEntry = {
        ...ownRegistryTwin,
        hostId: "stale-host-id-from-a-previous-enrollment",
      };
      const reEnrolledTwin: HostDirectoryEntry = {
        ...ownRegistryTwin,
        hostId: "re-enrolled-host-id",
      };
      const directory = makeDirectory({
        authContextId: null,
        credentialGeneration: null,
        runnerHost: makeHost(null),
        localHostIdSeeder: () => Promise.resolve("re-enrolled-host-id"),
        // The registry still lists BOTH rows until deregistration propagates -
        // the exact window where the obsolete twin is remote-kind and dialable.
        remoteFetcher: () =>
          Promise.resolve({
            kind: "hosts",
            entries: [obsoleteTwin, reEnrolledTwin],
          }),
      });
      await directory.start();

      expect(directory.getSelected()?.hostId).toBe("re-enrolled-host-id");
      // Restored as this machine: the coerced non-dialable local presentation,
      // never the obsolete twin's relay URL.
      expect(directory.getSelected()).toMatchObject({
        kind: "local",
        websocketUrl: null,
      });
      expect(window.localStorage.getItem(LAST_SELECTED_HOST_STORAGE_KEY)).toBe(
        "re-enrolled-host-id",
      );
    });

    /**
     * The other holder: a LIVE selection. `reconcileSelection()` keeps any id
     * it can still find, and the obsolete twin stays listed until the registry
     * catches up - so intent migration alone cannot move an already-bound
     * selection when the re-enrollment happens mid-session.
     */
    it("retargets a live selection of the old id when the host re-enrolls mid-session", async () => {
      window.localStorage.setItem(
        LAST_LOCAL_HOST_ID_STORAGE_KEY,
        localSnapshot.hostId,
      );
      const obsoleteTwin: HostDirectoryEntry = {
        ...ownRegistryTwin,
        hostId: localSnapshot.hostId,
      };
      const host = makeHost(localSnapshot);
      const directory = makeDirectory({
        authContextId: null,
        credentialGeneration: null,
        runnerHost: host,
        localHostIdSeeder: null,
        remoteFetcher: () =>
          Promise.resolve({ kind: "hosts", entries: [obsoleteTwin] }),
      });
      await directory.start();
      expect(directory.getSelected()?.hostId).toBe(localSnapshot.hostId);

      host.setLocalHost({
        ...localSnapshot,
        hostId: "re-enrolled-host-id",
      });
      await flushPromises();

      expect(directory.getSelected()?.hostId).toBe("re-enrolled-host-id");
      expect(directory.getSelected()?.kind).toBe("local");
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

    it("does not rewrite a remembered REMOTE selection on re-enrollment", async () => {
      // The migration must be scoped to selections that meant "this machine".
      window.localStorage.setItem(
        LAST_LOCAL_HOST_ID_STORAGE_KEY,
        "stale-host-id-from-a-previous-enrollment",
      );
      rememberHostSelection(rememberedRemoteHostEntry.hostId);
      const directory = makeDirectory({
        authContextId: null,
        credentialGeneration: null,
        runnerHost: makeHost(null),
        localHostIdSeeder: () => Promise.resolve("re-enrolled-host-id"),
        remoteFetcher: () =>
          Promise.resolve({
            kind: "hosts",
            entries: [rememberedRemoteHostEntry],
          }),
      });
      await directory.start();

      expect(directory.getSelected()?.hostId).toBe(
        rememberedRemoteHostEntry.hostId,
      );
      expect(window.localStorage.getItem(LAST_SELECTED_HOST_STORAGE_KEY)).toBe(
        rememberedRemoteHostEntry.hostId,
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

  /**
   * D7 auto-failover: a selection the registry still lists but nothing can
   * dial is re-homed after two consecutive genuine refreshes, transiently,
   * and handed back when the user's own host returns.
   */
  describe("reconcileSelectionDialability (D7 auto-failover)", () => {
    beforeEach(() => {
      toastInfo.mockClear();
    });

    /** A listed row that is no longer usable - the D7 debounce subject. */
    function asNonDialable(entry: HostDirectoryEntry): HostDirectoryEntry {
      return {
        ...entry,
        websocketUrl: null,
        transportDialability: "not-dialable",
      };
    }

    it("fails over a listed-but-non-dialable remote selection only on the second consecutive genuine refresh", async () => {
      // Pins the debounce itself: a one-emission implementation would move on
      // the first non-dialable read and pass an end-state-only assertion.
      let remotes: readonly HostDirectoryEntry[] = [
        rememberedRemoteHostEntry,
        secondRemoteHostEntry,
      ];
      const directory = makeDirectory({
        authContextId: null,
        credentialGeneration: null,
        runnerHost: makeHost(null),
        localHostIdSeeder: null,
        remoteFetcher: () =>
          Promise.resolve({ kind: "hosts", entries: remotes }),
      });
      await directory.start();
      directory.selectById(rememberedRemoteHostEntry.hostId);
      expect(directory.getSelected()?.hostId).toBe(
        rememberedRemoteHostEntry.hostId,
      );

      remotes = [
        asNonDialable(rememberedRemoteHostEntry),
        secondRemoteHostEntry,
      ];
      await directory.refresh();
      expect(directory.getSelected()?.hostId).toBe(
        rememberedRemoteHostEntry.hostId,
      );

      await directory.refresh();
      expect(directory.getSelected()?.hostId).toBe(
        secondRemoteHostEntry.hostId,
      );
    });

    it("prefers a dialable local failover target over a dialable remote, and never the dead or a non-dialable host", async () => {
      // Pins nextAvailableEntry: local first, never the corpse, never a row
      // that would just re-arm the failover on the next poll.
      const nonDialableOther: HostDirectoryEntry = asNonDialable({
        hostId: "non-dialable-other",
        label: "Dead Other",
        kind: "remote",
        websocketUrl: "wss://dead-other.traycer.invalid/rpc",
        version: "0.0.0-mock",
        transportDialability: "dialable",
      });
      let remotes: readonly HostDirectoryEntry[] = [
        rememberedRemoteHostEntry,
        secondRemoteHostEntry,
        nonDialableOther,
      ];
      const directory = makeDirectory({
        authContextId: null,
        credentialGeneration: null,
        runnerHost: makeHost(localSnapshot),
        localHostIdSeeder: null,
        remoteFetcher: () =>
          Promise.resolve({ kind: "hosts", entries: remotes }),
      });
      await directory.start();
      directory.selectById(rememberedRemoteHostEntry.hostId);

      remotes = [
        asNonDialable(rememberedRemoteHostEntry),
        secondRemoteHostEntry,
        nonDialableOther,
      ];
      await directory.refresh();
      expect(directory.getSelected()?.hostId).toBe(
        rememberedRemoteHostEntry.hostId,
      );
      await directory.refresh();

      expect(directory.getSelected()?.hostId).toBe(localSnapshot.hostId);
      expect(directory.getSelected()?.hostId).not.toBe(
        rememberedRemoteHostEntry.hostId,
      );
      expect(directory.getSelected()?.hostId).not.toBe(nonDialableOther.hostId);
    });

    it("continues a failover when the target AND the origin both vanish", async () => {
      // The gap between the two moves D7 makes. `reconcileSelection` resolves a
      // vanished selection from intent, and intent still names the origin the
      // failover moved off - so when BOTH leave the registry it resolves to
      // `null` and unbinds. `failOverFromDeadSelection` cannot recover it
      // either: it returns immediately on a null selection. The window stranded
      // with a perfectly dialable third host listed.
      //
      // The "an explicit pick resolves to null" rule is not violated by moving
      // here: a failover already moved this window off that pick once, which is
      // what `failoverOriginHostId` records. Continuing is the same decision.
      let remotes: readonly HostDirectoryEntry[] = [
        rememberedRemoteHostEntry,
        secondRemoteHostEntry,
      ];
      const directory = makeDirectory({
        authContextId: null,
        credentialGeneration: null,
        runnerHost: makeHost(null),
        localHostIdSeeder: null,
        remoteFetcher: () =>
          Promise.resolve({ kind: "hosts", entries: remotes }),
      });
      await directory.start();
      directory.selectById(rememberedRemoteHostEntry.hostId);

      // Fail over off the explicit pick onto the second remote.
      remotes = [
        asNonDialable(rememberedRemoteHostEntry),
        secondRemoteHostEntry,
      ];
      await directory.refresh();
      await directory.refresh();
      expect(directory.getSelected()?.hostId).toBe(
        secondRemoteHostEntry.hostId,
      );

      // Now BOTH the failover target and the origin leave the directory, and a
      // third dialable host arrives. Before this fix the app unbound here.
      remotes = [thirdRemoteHostEntry];
      await directory.refresh();
      expect(directory.getSelected()?.hostId).toBe(thirdRemoteHostEntry.hostId);
    });

    it("keeps explicitSelection on the dead host through failover and re-adopts when it is dialable again", async () => {
      // Pins D7.3: failover is transient (explicit pick survives), recovery is
      // damped to TWO consecutive genuine dialable reads (same bar as death),
      // and an explicit selectById in between retires the re-adoption.
      let remotes: readonly HostDirectoryEntry[] = [
        rememberedRemoteHostEntry,
        secondRemoteHostEntry,
      ];
      const directory = makeDirectory({
        authContextId: null,
        credentialGeneration: null,
        runnerHost: makeHost(null),
        localHostIdSeeder: null,
        remoteFetcher: () =>
          Promise.resolve({ kind: "hosts", entries: remotes }),
      });
      await directory.start();
      directory.selectById(rememberedRemoteHostEntry.hostId);

      remotes = [
        asNonDialable(rememberedRemoteHostEntry),
        secondRemoteHostEntry,
      ];
      await directory.refresh();
      await directory.refresh();
      expect(directory.getSelected()?.hostId).toBe(
        secondRemoteHostEntry.hostId,
      );
      // Explicit pick still names the dead host: if the failover target leaves,
      // reconcileSelection resolves intent back to that id (still listed).
      remotes = [asNonDialable(rememberedRemoteHostEntry)];
      await directory.refresh();
      expect(directory.getSelected()?.hostId).toBe(
        rememberedRemoteHostEntry.hostId,
      );

      // Re-select a live pair, fail over again, then re-adopt when origin
      // answers TWO consecutive genuine dialable reads.
      remotes = [
        asNonDialable(rememberedRemoteHostEntry),
        secondRemoteHostEntry,
      ];
      directory.selectById(rememberedRemoteHostEntry.hostId);
      await directory.refresh();
      await directory.refresh();
      expect(directory.getSelected()?.hostId).toBe(
        secondRemoteHostEntry.hostId,
      );

      remotes = [rememberedRemoteHostEntry, secondRemoteHostEntry];
      await directory.refresh();
      // One dialable read is a blip - same negative pin as the death debounce.
      expect(directory.getSelected()?.hostId).toBe(
        secondRemoteHostEntry.hostId,
      );
      await directory.refresh();
      expect(directory.getSelected()?.hostId).toBe(
        rememberedRemoteHostEntry.hostId,
      );

      // selectById retires the origin marker: a later recovery must not yank
      // the user back after they picked something else.
      remotes = [
        asNonDialable(rememberedRemoteHostEntry),
        secondRemoteHostEntry,
      ];
      directory.selectById(rememberedRemoteHostEntry.hostId);
      await directory.refresh();
      await directory.refresh();
      expect(directory.getSelected()?.hostId).toBe(
        secondRemoteHostEntry.hostId,
      );
      directory.selectById(secondRemoteHostEntry.hostId);
      remotes = [rememberedRemoteHostEntry, secondRemoteHostEntry];
      await directory.refresh();
      await directory.refresh();
      expect(directory.getSelected()?.hostId).toBe(
        secondRemoteHostEntry.hostId,
      );
    });

    it("does not fail over when the dead host is the only host / no dialable candidate exists", async () => {
      // Pins the empty-candidate no-op: moving to a second non-dialable host
      // (or nowhere) would re-home the window every poll and still leave the
      // user stranded - readiness owns that surface instead.
      let remotes: readonly HostDirectoryEntry[] = [rememberedRemoteHostEntry];
      const directory = makeDirectory({
        authContextId: null,
        credentialGeneration: null,
        runnerHost: makeHost(null),
        localHostIdSeeder: null,
        remoteFetcher: () =>
          Promise.resolve({ kind: "hosts", entries: remotes }),
      });
      await directory.start();
      expect(directory.getSelected()?.hostId).toBe(
        rememberedRemoteHostEntry.hostId,
      );

      remotes = [asNonDialable(rememberedRemoteHostEntry)];
      await directory.refresh();
      await directory.refresh();
      await directory.refresh();
      expect(directory.getSelected()?.hostId).toBe(
        rememberedRemoteHostEntry.hostId,
      );
    });

    it("never fails over a non-dialable local-kind selection even when a dialable remote is listed", async () => {
      // Pins the this-machine guard: a local row that cannot be dialed is a
      // host booting/restarting, and treating it as death re-homes the window
      // off the machine whose provisioning lifecycle owns recovery.
      window.localStorage.setItem(
        LAST_LOCAL_HOST_ID_STORAGE_KEY,
        localSnapshot.hostId,
      );
      // Many-entry directories do not auto-promote (Flow 6); pin the booting
      // twin the way a remembered local selection does during restart.
      rememberHostSelection(localSnapshot.hostId);
      const registryTwin: HostDirectoryEntry = {
        hostId: localSnapshot.hostId,
        label: "Registry twin",
        kind: "remote",
        websocketUrl: "wss://relay.traycer.invalid/attach",
        version: "0.0.0-mock",
        transportDialability: "dialable",
      };
      const directory = makeDirectory({
        authContextId: null,
        credentialGeneration: null,
        runnerHost: makeHost(null),
        localHostIdSeeder: null,
        remoteFetcher: () =>
          Promise.resolve({
            kind: "hosts",
            entries: [registryTwin, secondRemoteHostEntry],
          }),
      });
      await directory.start();
      expect(directory.getSelected()?.hostId).toBe(localSnapshot.hostId);
      expect(directory.getSelected()?.kind).toBe("local");
      expect(directory.getSelected()?.websocketUrl).toBeNull();

      await directory.refresh();
      await directory.refresh();
      await directory.refresh();
      expect(directory.getSelected()?.hostId).toBe(localSnapshot.hostId);
      expect(directory.getSelected()?.kind).toBe("local");
    });

    it("resets the non-dialable streak when the selection becomes dialable again between blips", async () => {
      // Pins streak reset on recovery: non-dialable once, dialable, non-dialable
      // once must not fail over - only consecutive genuine non-dialable reads.
      let remotes: readonly HostDirectoryEntry[] = [
        rememberedRemoteHostEntry,
        secondRemoteHostEntry,
      ];
      const directory = makeDirectory({
        authContextId: null,
        credentialGeneration: null,
        runnerHost: makeHost(null),
        localHostIdSeeder: null,
        remoteFetcher: () =>
          Promise.resolve({ kind: "hosts", entries: remotes }),
      });
      await directory.start();
      directory.selectById(rememberedRemoteHostEntry.hostId);

      remotes = [
        asNonDialable(rememberedRemoteHostEntry),
        secondRemoteHostEntry,
      ];
      await directory.refresh();
      expect(directory.getSelected()?.hostId).toBe(
        rememberedRemoteHostEntry.hostId,
      );

      remotes = [rememberedRemoteHostEntry, secondRemoteHostEntry];
      await directory.refresh();
      expect(directory.getSelected()?.hostId).toBe(
        rememberedRemoteHostEntry.hostId,
      );

      remotes = [
        asNonDialable(rememberedRemoteHostEntry),
        secondRemoteHostEntry,
      ];
      await directory.refresh();
      expect(directory.getSelected()?.hostId).toBe(
        rememberedRemoteHostEntry.hostId,
      );
    });

    it("does not advance the non-dialable debounce on a failed fetcher outcome", async () => {
      // Pins failed-path isolation: a failed refresh retains last-known rows
      // and must not count as a genuine dialability read. If it did, one
      // non-dialable + one failed would re-home on the failed path.
      const { fetcher } = queuedFetcher([
        {
          kind: "hosts",
          entries: [rememberedRemoteHostEntry, secondRemoteHostEntry],
        },
        {
          kind: "hosts",
          entries: [
            asNonDialable(rememberedRemoteHostEntry),
            secondRemoteHostEntry,
          ],
        },
        { kind: "failed" },
        {
          kind: "hosts",
          entries: [
            asNonDialable(rememberedRemoteHostEntry),
            secondRemoteHostEntry,
          ],
        },
      ]);
      const directory = makeDirectory({
        authContextId: null,
        credentialGeneration: null,
        runnerHost: makeHost(null),
        localHostIdSeeder: null,
        remoteFetcher: fetcher,
      });
      await directory.start();
      directory.selectById(rememberedRemoteHostEntry.hostId);

      await directory.refresh();
      expect(directory.getSelected()?.hostId).toBe(
        rememberedRemoteHostEntry.hostId,
      );

      await directory.refresh();
      expect(directory.getSelected()?.hostId).toBe(
        rememberedRemoteHostEntry.hostId,
      );

      await directory.refresh();
      // Second genuine non-dialable read (failed did not count) → now fail over.
      expect(directory.getSelected()?.hostId).toBe(
        secondRemoteHostEntry.hostId,
      );
    });

    /**
     * `isConfirmedHostDeath` composition — the P0 the review named directly.
     *
     * `asNonDialable` above is a SYNTHETIC literal with no `remoteStatus`, so
     * `hostUnavailability` falls straight to its non-remote branch
     * (`"offline"`) regardless of what it is meant to represent — every
     * existing D7 test above is, without knowing it, only ever exercising the
     * genuinely-dead case. These compose REAL entries from
     * `hostListItemToDirectoryEntry` instead, so the `connectivity: "unknown"`
     * case is actually reachable: a degraded liveness read maps `status` to
     * the exact same `"unavailable"` `asNonDialable` fakes, but
     * `isConfirmedHostDeath` must refuse to treat it as evidence.
     *
     * This is also the case the old per-poll debounce could never catch: a
     * degraded cloud read re-polls to the SAME degraded answer, so two
     * consecutive reads agree and the streak completes anyway. Only gating on
     * the REASON (not just "two non-dialable reads in a row") fixes it.
     */
    describe("isConfirmedHostDeath composition — real mapped connectivity, not a synthetic unavailable literal", () => {
      function realRemoteEntry(
        hostId: string,
        displayName: string,
        connectivity: "connectable" | "unknown" | "offline" | "local-only",
      ): HostDirectoryEntry {
        return hostListItemToDirectoryEntry(
          {
            hostId,
            displayName,
            platform: "Ubuntu",
            kind: "personal",
            publicKey: `pk-${hostId}`,
            createdAt: "2026-07-01T12:00:00.000Z",
            status: {
              connectivity,
              viewerReachability: "unknown",
              clientCloud: "ok",
              updateState: "current",
              appVersion: "1.4.2",
              lastSeenAt: "2026-07-03T11:59:50.000Z",
            },
            updatePolicy: "manual",
          },
          "wss://relay.example.test/attach",
        );
      }

      it("does NOT fail over a selected remote host across two consecutive 'unknown' reads — a degraded read is not evidence of death", async () => {
        const remembered = realRemoteEntry(
          "remembered-real",
          "Remembered Real",
          "connectable",
        );
        const second = realRemoteEntry(
          "second-real",
          "Second Real",
          "connectable",
        );
        let remotes: readonly HostDirectoryEntry[] = [remembered, second];
        const directory = makeDirectory({
          authContextId: null,
          credentialGeneration: null,
          runnerHost: makeHost(null),
          localHostIdSeeder: null,
          remoteFetcher: () =>
            Promise.resolve({ kind: "hosts", entries: remotes }),
        });
        await directory.start();
        directory.selectById(remembered.hostId);
        expect(directory.getSelected()?.hostId).toBe(remembered.hostId);

        // The cloud goes blind on this host. Both this entry's mapped `status`
        // ("unavailable") AND its dialability are identical to the genuinely-dead
        // case above — the only thing that differs is `remoteStatus.connectivity`.
        remotes = [
          realRemoteEntry("remembered-real", "Remembered Real", "unknown"),
          second,
        ];
        await directory.refresh();
        expect(directory.getSelected()?.hostId).toBe(remembered.hostId);

        // A second consecutive genuine read, still "unknown" — re-polling a
        // degraded read returns the same degraded answer, which is exactly why
        // the old debounce alone could not have protected this case.
        await directory.refresh();
        expect(directory.getSelected()?.hostId).toBe(remembered.hostId);
      });

      it("DOES fail over the same selected host across two consecutive genuinely 'offline' reads", async () => {
        const remembered = realRemoteEntry(
          "remembered-real",
          "Remembered Real",
          "connectable",
        );
        const second = realRemoteEntry(
          "second-real",
          "Second Real",
          "connectable",
        );
        let remotes: readonly HostDirectoryEntry[] = [remembered, second];
        const directory = makeDirectory({
          authContextId: null,
          credentialGeneration: null,
          runnerHost: makeHost(null),
          localHostIdSeeder: null,
          remoteFetcher: () =>
            Promise.resolve({ kind: "hosts", entries: remotes }),
        });
        await directory.start();
        directory.selectById(remembered.hostId);

        remotes = [
          realRemoteEntry("remembered-real", "Remembered Real", "offline"),
          second,
        ];
        await directory.refresh();
        expect(directory.getSelected()?.hostId).toBe(remembered.hostId);

        await directory.refresh();
        expect(directory.getSelected()?.hostId).toBe(second.hostId);
      });

      it("does NOT fail over a 'local-only' (plan-restricted) selection either — it is not dead, it is billing", async () => {
        const remembered = realRemoteEntry(
          "remembered-real",
          "Remembered Real",
          "connectable",
        );
        const second = realRemoteEntry(
          "second-real",
          "Second Real",
          "connectable",
        );
        let remotes: readonly HostDirectoryEntry[] = [remembered, second];
        const directory = makeDirectory({
          authContextId: null,
          credentialGeneration: null,
          runnerHost: makeHost(null),
          localHostIdSeeder: null,
          remoteFetcher: () =>
            Promise.resolve({ kind: "hosts", entries: remotes }),
        });
        await directory.start();
        directory.selectById(remembered.hostId);

        remotes = [
          realRemoteEntry("remembered-real", "Remembered Real", "local-only"),
          second,
        ];
        await directory.refresh();
        await directory.refresh();
        expect(directory.getSelected()?.hostId).toBe(remembered.hostId);
      });
    });

    it("toasts on failover and on re-adoption of the origin host", async () => {
      // Pins both announcement directions and one-move-one-toast: a silent
      // re-home reads as a bug; a double toast on one move is also wrong.
      let remotes: readonly HostDirectoryEntry[] = [
        rememberedRemoteHostEntry,
        secondRemoteHostEntry,
      ];
      const directory = makeDirectory({
        authContextId: null,
        credentialGeneration: null,
        runnerHost: makeHost(null),
        localHostIdSeeder: null,
        remoteFetcher: () =>
          Promise.resolve({ kind: "hosts", entries: remotes }),
      });
      await directory.start();
      directory.selectById(rememberedRemoteHostEntry.hostId);

      remotes = [
        asNonDialable(rememberedRemoteHostEntry),
        secondRemoteHostEntry,
      ];
      await directory.refresh();
      await directory.refresh();
      expect(toastInfo).toHaveBeenCalledTimes(1);
      expect(toastInfo).toHaveBeenCalledWith(
        `Switched to ${secondRemoteHostEntry.label}`,
        {
          description: `${rememberedRemoteHostEntry.label} stopped responding.`,
        },
      );

      remotes = [rememberedRemoteHostEntry, secondRemoteHostEntry];
      await directory.refresh();
      // Recovery is damped: the first dialable read must not re-home or toast.
      expect(directory.getSelected()?.hostId).toBe(
        secondRemoteHostEntry.hostId,
      );
      expect(toastInfo).toHaveBeenCalledTimes(1);

      await directory.refresh();
      expect(directory.getSelected()?.hostId).toBe(
        rememberedRemoteHostEntry.hostId,
      );
      expect(toastInfo).toHaveBeenCalledTimes(2);
      expect(toastInfo).toHaveBeenLastCalledWith(
        `Switched to ${rememberedRemoteHostEntry.label}`,
        {
          description: `${rememberedRemoteHostEntry.label} is available again.`,
        },
      );
    });

    it("does not re-adopt when the origin flaps dialable once then lapses", async () => {
      // HIGH: recovery streak must restart from zero across a gap. If it
      // accumulated, dialable → non-dialable → dialable would re-home on the
      // second dialable read even though they were never consecutive.
      let remotes: readonly HostDirectoryEntry[] = [
        rememberedRemoteHostEntry,
        secondRemoteHostEntry,
      ];
      const directory = makeDirectory({
        authContextId: null,
        credentialGeneration: null,
        runnerHost: makeHost(null),
        localHostIdSeeder: null,
        remoteFetcher: () =>
          Promise.resolve({ kind: "hosts", entries: remotes }),
      });
      await directory.start();
      directory.selectById(rememberedRemoteHostEntry.hostId);

      remotes = [
        asNonDialable(rememberedRemoteHostEntry),
        secondRemoteHostEntry,
      ];
      await directory.refresh();
      await directory.refresh();
      expect(directory.getSelected()?.hostId).toBe(
        secondRemoteHostEntry.hostId,
      );
      expect(toastInfo).toHaveBeenCalledTimes(1);

      remotes = [rememberedRemoteHostEntry, secondRemoteHostEntry];
      await directory.refresh();
      expect(directory.getSelected()?.hostId).toBe(
        secondRemoteHostEntry.hostId,
      );

      remotes = [
        asNonDialable(rememberedRemoteHostEntry),
        secondRemoteHostEntry,
      ];
      await directory.refresh();
      expect(directory.getSelected()?.hostId).toBe(
        secondRemoteHostEntry.hostId,
      );

      remotes = [rememberedRemoteHostEntry, secondRemoteHostEntry];
      await directory.refresh();
      expect(directory.getSelected()?.hostId).toBe(
        secondRemoteHostEntry.hostId,
      );
      expect(toastInfo).toHaveBeenCalledTimes(1);
    });

    it("retires the failover marker on signed-out so a later session does not re-adopt with a toast", async () => {
      // Pins authoritative clear on sign-out: the marker must not outlive the
      // session whose pick armed it.
      // Local host is required in this fixture: it is the failover target
      // (`nextAvailableEntry` prefers dialable local) and SURVIVES signed-out
      // (only remotes clear). Without it, selection goes null and intent
      // re-binds the origin silently - toast stays 1 even with the retire
      // line deleted, so the test would pin nothing.
      const { fetcher } = queuedFetcher([
        {
          kind: "hosts",
          entries: [rememberedRemoteHostEntry, secondRemoteHostEntry],
        },
        {
          kind: "hosts",
          entries: [
            asNonDialable(rememberedRemoteHostEntry),
            secondRemoteHostEntry,
          ],
        },
        {
          kind: "hosts",
          entries: [
            asNonDialable(rememberedRemoteHostEntry),
            secondRemoteHostEntry,
          ],
        },
        { kind: "signed-out" },
        {
          kind: "hosts",
          entries: [rememberedRemoteHostEntry, secondRemoteHostEntry],
        },
        {
          kind: "hosts",
          entries: [rememberedRemoteHostEntry, secondRemoteHostEntry],
        },
        {
          kind: "hosts",
          entries: [rememberedRemoteHostEntry, secondRemoteHostEntry],
        },
      ]);
      const directory = makeDirectory({
        authContextId: null,
        credentialGeneration: null,
        runnerHost: makeHost(localSnapshot),
        localHostIdSeeder: null,
        remoteFetcher: fetcher,
      });
      await directory.start();
      directory.selectById(rememberedRemoteHostEntry.hostId);

      await directory.refresh();
      await directory.refresh();
      expect(directory.getSelected()?.hostId).toBe(localSnapshot.hostId);
      expect(toastInfo).toHaveBeenCalledTimes(1);

      await directory.refresh();
      // signed-out clears remotes; local row (and selection on it) survive.
      expect(directory.getSelected()?.hostId).toBe(localSnapshot.hostId);
      expect(
        (await directory.list()).some(
          (entry) => entry.hostId === localSnapshot.hostId,
        ),
      ).toBe(true);

      await directory.refresh();
      await directory.refresh();
      await directory.refresh();
      // Discriminator: selection stays on the failover target AND no second
      // toast. Without retireFailoverStateOnAuthoritativeClear the marker
      // would re-adopt the origin on the 2nd dialable read.
      expect(directory.getSelected()?.hostId).toBe(localSnapshot.hostId);
      expect(toastInfo).toHaveBeenCalledTimes(1);
    });

    it("retires the failover marker on an empty genuine hosts outcome so the origin is not re-adopted", async () => {
      // Counterpart of sign-out for the empty-directory epoch.
      // Local host is required in this fixture: it is the failover target
      // that SURVIVES an empty remotes batch (only remotes clear). Without it
      // the test is vacuous - selection goes null and intent re-binds origin
      // silently either with or without the retire line.
      const { fetcher } = queuedFetcher([
        {
          kind: "hosts",
          entries: [rememberedRemoteHostEntry, secondRemoteHostEntry],
        },
        {
          kind: "hosts",
          entries: [
            asNonDialable(rememberedRemoteHostEntry),
            secondRemoteHostEntry,
          ],
        },
        {
          kind: "hosts",
          entries: [
            asNonDialable(rememberedRemoteHostEntry),
            secondRemoteHostEntry,
          ],
        },
        { kind: "hosts", entries: [] },
        {
          kind: "hosts",
          entries: [rememberedRemoteHostEntry, secondRemoteHostEntry],
        },
        {
          kind: "hosts",
          entries: [rememberedRemoteHostEntry, secondRemoteHostEntry],
        },
        {
          kind: "hosts",
          entries: [rememberedRemoteHostEntry, secondRemoteHostEntry],
        },
      ]);
      const directory = makeDirectory({
        authContextId: null,
        credentialGeneration: null,
        runnerHost: makeHost(localSnapshot),
        localHostIdSeeder: null,
        remoteFetcher: fetcher,
      });
      await directory.start();
      directory.selectById(rememberedRemoteHostEntry.hostId);

      await directory.refresh();
      await directory.refresh();
      expect(directory.getSelected()?.hostId).toBe(localSnapshot.hostId);
      expect(toastInfo).toHaveBeenCalledTimes(1);

      await directory.refresh();
      // Empty remotes; local row (and selection on it) survive.
      expect(directory.getSelected()?.hostId).toBe(localSnapshot.hostId);

      await directory.refresh();
      await directory.refresh();
      await directory.refresh();
      // Discriminator: selection stays on the failover target AND no second
      // toast. Without retireFailoverStateOnAuthoritativeClear the marker
      // would re-adopt the origin on the 2nd dialable read.
      expect(directory.getSelected()?.hostId).toBe(localSnapshot.hostId);
      expect(toastInfo).toHaveBeenCalledTimes(1);
    });

    it("does not retire the failover marker when the origin is merely missing from a still-populated list", async () => {
      // Counterpart of the authoritative-clear pins: a missing origin while
      // other hosts remain is the outage this feature exists for - the pick
      // must still re-adopt after two consecutive dialable returns.
      let remotes: readonly HostDirectoryEntry[] = [
        rememberedRemoteHostEntry,
        secondRemoteHostEntry,
      ];
      const directory = makeDirectory({
        authContextId: null,
        credentialGeneration: null,
        runnerHost: makeHost(null),
        localHostIdSeeder: null,
        remoteFetcher: () =>
          Promise.resolve({ kind: "hosts", entries: remotes }),
      });
      await directory.start();
      directory.selectById(rememberedRemoteHostEntry.hostId);

      remotes = [
        asNonDialable(rememberedRemoteHostEntry),
        secondRemoteHostEntry,
      ];
      await directory.refresh();
      await directory.refresh();
      expect(directory.getSelected()?.hostId).toBe(
        secondRemoteHostEntry.hostId,
      );
      expect(toastInfo).toHaveBeenCalledTimes(1);

      remotes = [secondRemoteHostEntry];
      await directory.refresh();
      expect(directory.getSelected()?.hostId).toBe(
        secondRemoteHostEntry.hostId,
      );

      remotes = [rememberedRemoteHostEntry, secondRemoteHostEntry];
      await directory.refresh();
      expect(directory.getSelected()?.hostId).toBe(
        secondRemoteHostEntry.hostId,
      );
      expect(toastInfo).toHaveBeenCalledTimes(1);
      await directory.refresh();
      expect(directory.getSelected()?.hostId).toBe(
        rememberedRemoteHostEntry.hostId,
      );
      expect(toastInfo).toHaveBeenCalledTimes(2);
      expect(toastInfo).toHaveBeenLastCalledWith(
        `Switched to ${rememberedRemoteHostEntry.label}`,
        {
          description: `${rememberedRemoteHostEntry.label} is available again.`,
        },
      );
    });

    /**
     * F7: the fuse-vs-lease reconciliation. An `offline` verdict the relay's
     * host-leg fuse is still plausibly holding (recent `lastSeenAt`) reads as
     * `indeterminate`, not confirmed death - so it must not drive the D7
     * auto-failover, and a non-explicit (auto/default/transient) selection
     * must still be handed back once its origin recovers.
     */
    describe("F7 relay fuse grace vs. D7 auto-failover", () => {
      const CONNECTABLE_LAST_SEEN = "2026-07-03T11:59:50.000Z";

      function realRemoteEntryWithLastSeen(
        hostId: string,
        displayName: string,
        connectivity: "connectable" | "unknown" | "offline" | "local-only",
        lastSeenAt: string,
      ): HostDirectoryEntry {
        return hostListItemToDirectoryEntry(
          {
            hostId,
            displayName,
            platform: "Ubuntu",
            kind: "personal",
            publicKey: `pk-${hostId}`,
            createdAt: "2026-07-01T12:00:00.000Z",
            status: {
              connectivity,
              viewerReachability: "unknown",
              clientCloud: "ok",
              updateState: "current",
              appVersion: "1.4.2",
              lastSeenAt,
            },
            updatePolicy: "manual",
          },
          "wss://relay.example.test/attach",
        );
      }

      it("PAIRED (a): lease-lapse offline whose recovery dial SUCCEEDED (ready session) is not re-homed", async () => {
        const first = realRemoteEntryWithLastSeen(
          "fuse-first",
          "Fuse First",
          "connectable",
          CONNECTABLE_LAST_SEEN,
        );
        const second = realRemoteEntryWithLastSeen(
          "fuse-second",
          "Fuse Second",
          "connectable",
          CONNECTABLE_LAST_SEEN,
        );
        let remotes: readonly HostDirectoryEntry[] = [first, second];
        const directory = makeDirectory({
          authContextId: null,
          credentialGeneration: null,
          runnerHost: makeHost(null),
          localHostIdSeeder: null,
          remoteFetcher: () =>
            Promise.resolve({ kind: "hosts", entries: remotes }),
        });
        await directory.start();
        directory.selectById(first.hostId);
        expect(directory.getSelected()?.hostId).toBe(first.hostId);

        // The lease has lapsed (cloud reports `offline`) with a recent
        // `lastSeenAt`, and the relay leg really is still attached: the
        // recovery dial the fuse window keeps open has succeeded, so a ready
        // live session exists. That session - firsthand, present-tense
        // evidence, not the timestamp - is what suppresses the failover.
        readySessionHosts.value.add("fuse-first");
        const recentLastSeen = new Date(Date.now() - 60_000).toISOString();
        remotes = [
          realRemoteEntryWithLastSeen(
            "fuse-first",
            "Fuse First",
            "offline",
            recentLastSeen,
          ),
          second,
        ];
        await directory.refresh();
        await directory.refresh();
        await directory.refresh();
        expect(directory.getSelected()?.hostId).toBe(first.hostId);
      });

      it("PAIRED (b): the same recent lastSeenAt with NO session (detach/crash) DOES re-home after two reads", async () => {
        // Observationally this host is identical to the lease-lapse case
        // above except for the dial outcome: it cleanly detached or crashed a
        // minute ago, so its `lastSeenAt` is just as recent, but no relay leg
        // answers. Before the P1 correction the fuse window rewrote this
        // `offline` to `indeterminate` from recency alone and the selection
        // stayed parked on a dead host for up to four hours.
        const first = realRemoteEntryWithLastSeen(
          "fuse-dead-first",
          "Fuse Dead First",
          "connectable",
          CONNECTABLE_LAST_SEEN,
        );
        const second = realRemoteEntryWithLastSeen(
          "fuse-dead-second",
          "Fuse Dead Second",
          "connectable",
          CONNECTABLE_LAST_SEEN,
        );
        let remotes: readonly HostDirectoryEntry[] = [first, second];
        const directory = makeDirectory({
          authContextId: null,
          credentialGeneration: null,
          runnerHost: makeHost(null),
          localHostIdSeeder: null,
          remoteFetcher: () =>
            Promise.resolve({ kind: "hosts", entries: remotes }),
        });
        await directory.start();
        directory.selectById(first.hostId);
        expect(directory.getSelected()?.hostId).toBe(first.hostId);

        const recentLastSeen = new Date(Date.now() - 60_000).toISOString();
        remotes = [
          realRemoteEntryWithLastSeen(
            "fuse-dead-first",
            "Fuse Dead First",
            "offline",
            recentLastSeen,
          ),
          second,
        ];
        await directory.refresh();
        // First read: the debounce holds.
        expect(directory.getSelected()?.hostId).toBe(first.hostId);
        await directory.refresh();
        // Second consecutive genuine read confirms death - failover fires.
        expect(directory.getSelected()?.hostId).toBe(second.hostId);
      });

      it("contrast: DOES re-home once the same host is genuinely offline, past the fuse cap", async () => {
        const first = realRemoteEntryWithLastSeen(
          "fuse-first-genuine",
          "Fuse First Genuine",
          "connectable",
          CONNECTABLE_LAST_SEEN,
        );
        const second = realRemoteEntryWithLastSeen(
          "fuse-second-genuine",
          "Fuse Second Genuine",
          "connectable",
          CONNECTABLE_LAST_SEEN,
        );
        let remotes: readonly HostDirectoryEntry[] = [first, second];
        const directory = makeDirectory({
          authContextId: null,
          credentialGeneration: null,
          runnerHost: makeHost(null),
          localHostIdSeeder: null,
          remoteFetcher: () =>
            Promise.resolve({ kind: "hosts", entries: remotes }),
        });
        await directory.start();
        directory.selectById(first.hostId);

        const oldLastSeen = new Date(
          Date.now() - 5 * 60 * 60 * 1000,
        ).toISOString();
        remotes = [
          realRemoteEntryWithLastSeen(
            "fuse-first-genuine",
            "Fuse First Genuine",
            "offline",
            oldLastSeen,
          ),
          second,
        ];
        await directory.refresh();
        expect(directory.getSelected()?.hostId).toBe(first.hostId);
        await directory.refresh();
        expect(directory.getSelected()?.hostId).toBe(second.hostId);
      });

      it("hands back an auto/default/transient selection after its origin recovers", async () => {
        const a = realRemoteEntryWithLastSeen(
          "hand-back-a",
          "Hand Back A",
          "connectable",
          CONNECTABLE_LAST_SEEN,
        );
        const b = realRemoteEntryWithLastSeen(
          "hand-back-b",
          "Hand Back B",
          "connectable",
          CONNECTABLE_LAST_SEEN,
        );
        let remotes: readonly HostDirectoryEntry[] = [a, b];
        const directory = makeDirectory({
          authContextId: null,
          credentialGeneration: null,
          runnerHost: makeHost(null),
          localHostIdSeeder: null,
          remoteFetcher: () =>
            Promise.resolve({ kind: "hosts", entries: remotes }),
        });
        await directory.start();

        // Selected through the TRANSIENT seam - `explicitSelection` is
        // deliberately NOT set here, which is the point of this test: before
        // F7, `failOverFromDeadSelection` only armed the hand-back marker for
        // an explicit pick, so a notification-driven transient selection like
        // this one would never have been handed back after its origin
        // recovered.
        directory.selectTransientById(a.hostId, "notification");
        expect(directory.getSelected()?.hostId).toBe(a.hostId);

        const oldLastSeen = new Date(
          Date.now() - 5 * 60 * 60 * 1000,
        ).toISOString();
        remotes = [
          realRemoteEntryWithLastSeen(
            "hand-back-a",
            "Hand Back A",
            "offline",
            oldLastSeen,
          ),
          b,
        ];
        await directory.refresh();
        await directory.refresh();
        expect(directory.getSelected()?.hostId).toBe(b.hostId);

        remotes = [
          realRemoteEntryWithLastSeen(
            "hand-back-a",
            "Hand Back A",
            "connectable",
            CONNECTABLE_LAST_SEEN,
          ),
          b,
        ];
        await directory.refresh();
        await directory.refresh();
        expect(directory.getSelected()?.hostId).toBe(a.hostId);
      });

      it("hands back to a failover origin proven live by a READY session while the registry still says offline", async () => {
        // Tabs stay bound to their origin host across an app-wide failover,
        // so a bound tab's fuse-recovery dial can succeed - producing a ready
        // session - while the registry spends the whole credential-plane
        // incident saying `offline`. That session is firsthand positive
        // evidence (the same evidence that outranks the cloud in
        // `isConfirmedTransportRefusal` / `isConfirmedHostDeath`), so the
        // hand-back must not wait for the cloud verdict to catch up.
        const a = realRemoteEntryWithLastSeen(
          "session-back-a",
          "Session Back A",
          "connectable",
          CONNECTABLE_LAST_SEEN,
        );
        const b = realRemoteEntryWithLastSeen(
          "session-back-b",
          "Session Back B",
          "connectable",
          CONNECTABLE_LAST_SEEN,
        );
        let remotes: readonly HostDirectoryEntry[] = [a, b];
        const directory = makeDirectory({
          authContextId: null,
          credentialGeneration: null,
          runnerHost: makeHost(null),
          localHostIdSeeder: null,
          remoteFetcher: () =>
            Promise.resolve({ kind: "hosts", entries: remotes }),
        });
        await directory.start();

        directory.selectTransientById(a.hostId, "notification");
        expect(directory.getSelected()?.hostId).toBe(a.hostId);

        // A dies genuinely (past the fuse window); failover parks on B.
        const oldLastSeen = new Date(
          Date.now() - 5 * 60 * 60 * 1000,
        ).toISOString();
        const offlineA = realRemoteEntryWithLastSeen(
          "session-back-a",
          "Session Back A",
          "offline",
          oldLastSeen,
        );
        remotes = [offlineA, b];
        await directory.refresh();
        await directory.refresh();
        expect(directory.getSelected()?.hostId).toBe(b.hostId);

        // A bound tab's dial to A succeeds; the registry row never changes.
        readySessionHosts.value.add("session-back-a");
        await directory.refresh();
        await directory.refresh();
        expect(directory.getSelected()?.hostId).toBe(a.hostId);
      });

      it("does NOT hand back over a newer notification-driven selection (P2): A -> failover B -> notification C -> A recovers => stays C", async () => {
        // The auto/transient seam the cold review named: the hand-back marker
        // remembers A, the user then follows a notification to C
        // (`selectTransientById`), and A's recovery must not steal the
        // selection from C - the notification bridge promises a switched
        // selection stays put. The marker is retired by the later
        // non-failover transient selection.
        const a = realRemoteEntryWithLastSeen(
          "steal-a",
          "Steal A",
          "connectable",
          CONNECTABLE_LAST_SEEN,
        );
        const b = realRemoteEntryWithLastSeen(
          "steal-b",
          "Steal B",
          "connectable",
          CONNECTABLE_LAST_SEEN,
        );
        const c = realRemoteEntryWithLastSeen(
          "steal-c",
          "Steal C",
          "connectable",
          CONNECTABLE_LAST_SEEN,
        );
        let remotes: readonly HostDirectoryEntry[] = [a, b, c];
        const directory = makeDirectory({
          authContextId: null,
          credentialGeneration: null,
          runnerHost: makeHost(null),
          localHostIdSeeder: null,
          remoteFetcher: () =>
            Promise.resolve({ kind: "hosts", entries: remotes }),
        });
        await directory.start();

        directory.selectTransientById(a.hostId, "notification");
        expect(directory.getSelected()?.hostId).toBe(a.hostId);

        // A dies (genuinely - past the fuse window); failover parks on B
        // (first dialable candidate) and the hand-back marker remembers A.
        const oldLastSeen = new Date(
          Date.now() - 5 * 60 * 60 * 1000,
        ).toISOString();
        remotes = [
          realRemoteEntryWithLastSeen(
            "steal-a",
            "Steal A",
            "offline",
            oldLastSeen,
          ),
          b,
          c,
        ];
        await directory.refresh();
        await directory.refresh();
        expect(directory.getSelected()?.hostId).toBe(b.hostId);

        // The user follows a notification to C before A recovers.
        directory.selectTransientById(c.hostId, "notification");
        expect(directory.getSelected()?.hostId).toBe(c.hostId);

        // A recovers and stays dialable for the full two-read damping - and
        // the selection must remain C across further polls.
        remotes = [
          realRemoteEntryWithLastSeen(
            "steal-a",
            "Steal A",
            "connectable",
            CONNECTABLE_LAST_SEEN,
          ),
          b,
          c,
        ];
        await directory.refresh();
        await directory.refresh();
        await directory.refresh();
        expect(directory.getSelected()?.hostId).toBe(c.hostId);
      });
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
