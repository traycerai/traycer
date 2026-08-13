import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { mockRemoteHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import type { LocalHostSnapshot } from "@traycer-clients/shared/platform/runner-host";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type {
  RemoteHostFetchOutcome,
  RemoteHostFetcher,
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

const HOST_DIRECTORY_REFRESH_POLL_MS = 15_000;
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
  status: "available",
};

const secondRemoteHostEntry: HostDirectoryEntry = {
  hostId: "second-remote-host",
  label: "Second Remote",
  kind: "remote",
  websocketUrl: "wss://second-remote.traycer.invalid/rpc",
  version: "0.0.0-mock",
  status: "available",
};

/** A third dialable remote, for the case where BOTH failover ends vanish. */
const thirdRemoteHostEntry: HostDirectoryEntry = {
  hostId: "third-remote-host",
  label: "Third Remote",
  kind: "remote",
  websocketUrl: "wss://third-remote.traycer.invalid/rpc",
  version: "0.0.0-mock",
  status: "available",
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

describe("HostDirectoryService", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("seeds the local entry from the runner-host onLocalHostChange subscription", async () => {
    const host = makeHost(localSnapshot);
    const directory = makeDirectory({
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
      status: "available",
    };
    const remoteFetcher: RemoteHostFetcher = () =>
      Promise.resolve({
        kind: "hosts",
        entries: [registeredLocalHostEntry, mockRemoteHostEntry],
      });
    const directory = makeDirectory({
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
      status: "available",
    };
    const directory = makeDirectory({
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

  it("retains the last-known remote entries and selection when a refresh fails (T20 / audit P4)", async () => {
    const host = makeHost(null);
    const { fetcher } = queuedFetcher([
      { kind: "hosts", entries: [mockRemoteHostEntry] },
      { kind: "failed" },
    ]);
    const directory = makeDirectory({
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
      status: "available",
    };
    const { fetcher } = queuedFetcher([
      { kind: "hosts", entries: [mockRemoteHostEntry, secondRemote] },
      { kind: "failed" },
    ]);
    const directory = makeDirectory({
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
      status: "available",
    };

    it("presents the machine's own registry twin as a non-dialable local entry", async () => {
      window.localStorage.setItem(
        LAST_LOCAL_HOST_ID_STORAGE_KEY,
        localSnapshot.hostId,
      );
      const host = makeHost(null);
      const directory = makeDirectory({
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
        // Not the twin's presence lease: `unavailable` is the truth, and it is
        // what leaves an `unavailable -> available` edge for status-transition
        // subscribers (e.g. landing-terminal tombstone recovery) when the real
        // host finally publishes.
        status: "unavailable",
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
        status: "unavailable",
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
        status: "available",
      });
      let remotes: readonly HostDirectoryEntry[] = [
        rememberedRemoteHostEntry,
        secondRemoteHostEntry,
        nonDialableOther,
      ];
      const directory = makeDirectory({
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
        status: "available",
      };
      const directory = makeDirectory({
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

    it("toasts on failover and on re-adoption of the origin host", async () => {
      // Pins both announcement directions and one-move-one-toast: a silent
      // re-home reads as a bug; a double toast on one move is also wrong.
      let remotes: readonly HostDirectoryEntry[] = [
        rememberedRemoteHostEntry,
        secondRemoteHostEntry,
      ];
      const directory = makeDirectory({
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
    status: "unavailable",
  };

  it("re-asks for this machine's id when the first ask came back null, and stops claiming its own host is a dead remote", async () => {
    // The shell cannot answer yet (host still booting, or the IPC query
    // resolved null and cached it).
    let shellHostId: string | null = null;
    const directory = makeDirectory({
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
    expect(beforeReseed[0].status).toBe("unavailable");

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
      status: "available",
      websocketUrl: localSnapshot.websocketUrl,
    });
  });

  it("carries a busy shell verdict through as a reachable local entry", async () => {
    // A host that lost a probe is still the host: dialable URL, `busy` status.
    // Publishing it as anything else is what put the registry twin - and its
    // hardcoded `unavailable` - in front of the user in the first place.
    const host = makeHost(null);
    const directory = makeDirectory({
      runnerHost: host,
      remoteFetcher: (): Promise<RemoteHostFetchOutcome> =>
        Promise.resolve({ kind: "hosts", entries: [] }),
      localHostIdSeeder: () => Promise.resolve(LOCAL_HOST_ID),
    });
    await directory.start();

    host.setLocalHost({ ...localSnapshot, availability: "busy" });

    expect((await directory.list())[0]).toMatchObject({
      kind: "local",
      status: "busy",
      websocketUrl: localSnapshot.websocketUrl,
    });
  });
});
