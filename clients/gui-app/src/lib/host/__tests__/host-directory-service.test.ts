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
import { lastSelectedHostKey } from "@/lib/persist";

const HOST_DIRECTORY_REFRESH_POLL_MS = 15_000;
const LAST_SELECTED_HOST_STORAGE_KEY = lastSelectedHostKey();

const localSnapshot: LocalHostSnapshot = {
  hostId: "desktop-pid-123",
  websocketUrl: "ws://127.0.0.1:4917/rpc",
  version: "1.2.3",
  pid: 4242,
  systemHostName: "hardiks-macbook",
  displayName: "hardiks-macbook",
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
});

afterEach(() => {
  for (const directory of directories.splice(0)) {
    directory.dispose();
  }
  window.localStorage.removeItem(LAST_SELECTED_HOST_STORAGE_KEY);
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
  it("seeds the local entry from the runner-host onLocalHostChange subscription", async () => {
    const host = makeHost(localSnapshot);
    const directory = makeDirectory({
      runnerHost: host,
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
    };
    const host = makeHost(renamedSnapshot);
    const directory = makeDirectory({
      runnerHost: host,
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
      remoteFetcher: null,
    });
    await directory.start();

    expect(await directory.list()).toEqual([]);
  });

  it("prefers the local entry as the default when one exists", async () => {
    const host = makeHost(localSnapshot);
    const directory = makeDirectory({
      runnerHost: host,
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
      remoteFetcher: fetcher,
    });

    const startPromise = directory.start();
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

  it("clears stale selection when the selected host is no longer in the directory", async () => {
    const host = makeHost(localSnapshot);
    const directory = makeDirectory({
      runnerHost: host,
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

  it("retains the last-known remote entries and selection when a refresh fails (T20 / audit P4)", async () => {
    const host = makeHost(null);
    const { fetcher } = queuedFetcher([
      { kind: "hosts", entries: [mockRemoteHostEntry] },
      { kind: "failed" },
    ]);
    const directory = makeDirectory({
      runnerHost: host,
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
});
