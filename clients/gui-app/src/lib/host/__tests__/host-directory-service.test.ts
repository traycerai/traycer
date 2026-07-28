import { afterEach, describe, expect, it, vi } from "vitest";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { mockRemoteHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import type { LocalHostSnapshot } from "@traycer-clients/shared/platform/runner-host";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { HostDirectoryService } from "@/lib/host/host-directory-service";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";

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

describe("HostDirectoryService", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("seeds the local entry from the runner-host onLocalHostChange subscription", async () => {
    const host = makeHost(localSnapshot);
    const directory = new HostDirectoryService({
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
    const directory = new HostDirectoryService({
      runnerHost: host,
      remoteFetcher: null,
    });
    await directory.start();

    expect(directory.getLocalEntry()?.label).toBe("Design Studio");
  });

  it("composes local snapshots with the configured remote fetcher", async () => {
    const host = makeHost(localSnapshot);
    const remoteFetcher = (): Promise<readonly HostDirectoryEntry[]> =>
      Promise.resolve([mockRemoteHostEntry]);
    const directory = new HostDirectoryService({
      runnerHost: host,
      remoteFetcher,
    });
    await directory.start();

    const entries = await directory.list();
    expect(entries.map((e) => e.kind)).toEqual(["local", "remote"]);
  });

  it("defaults to the shared stubbed remote fetcher when none is supplied", async () => {
    const host = makeHost(null);
    const directory = new HostDirectoryService({
      runnerHost: host,
      remoteFetcher: null,
    });
    await directory.start();

    expect(await directory.list()).toEqual([]);
  });

  it("prefers the local entry as the default when one exists", async () => {
    const host = makeHost(localSnapshot);
    const directory = new HostDirectoryService({
      runnerHost: host,
      remoteFetcher: () => Promise.resolve([mockRemoteHostEntry]),
    });
    await directory.start();

    const def = directory.getDefaultEntry();
    expect(def).not.toBeNull();
    expect(def?.kind).toBe("local");
  });

  it("falls back to the single remote entry when no local host exists and the directory has exactly one entry", async () => {
    const host = makeHost(null);
    const directory = new HostDirectoryService({
      runnerHost: host,
      remoteFetcher: () => Promise.resolve([mockRemoteHostEntry]),
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
    const directory = new HostDirectoryService({
      runnerHost: host,
      remoteFetcher: () => Promise.resolve([mockRemoteHostEntry, secondRemote]),
    });
    await directory.start();

    expect(directory.getCardinality()).toBe("many");
    expect(directory.getDefaultEntry()).toBeNull();
    expect(directory.getSelected()).toBeNull();
  });

  it("reports cardinality 'zero' when the directory has no local or remote entries", async () => {
    const host = makeHost(null);
    const directory = new HostDirectoryService({
      runnerHost: host,
      remoteFetcher: null,
    });
    await directory.start();

    expect(directory.getCardinality()).toBe("zero");
    expect(directory.getDefaultEntry()).toBeNull();
  });

  it("emits onSelectionChange after selectById()", async () => {
    const host = makeHost(localSnapshot);
    const directory = new HostDirectoryService({
      runnerHost: host,
      remoteFetcher: () => Promise.resolve([mockRemoteHostEntry]),
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

  it("clears stale selection when the selected host is no longer in the directory", async () => {
    const host = makeHost(localSnapshot);
    const directory = new HostDirectoryService({
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
    const directory = new HostDirectoryService({
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
    const directory = new HostDirectoryService({
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

    const directory = new HostDirectoryService({
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
    const directory = new HostDirectoryService({
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
    const directory = new HostDirectoryService({
      runnerHost: host,
      remoteFetcher: () => Promise.resolve([mockRemoteHostEntry]),
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
    const directory = new HostDirectoryService({
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
    const directory = new HostDirectoryService({
      runnerHost: host,
      remoteFetcher: () => Promise.resolve([mockRemoteHostEntry]),
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
    const directory = new HostDirectoryService({
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
    const directory = new HostDirectoryService({
      runnerHost: host,
      remoteFetcher: () => Promise.resolve([mockRemoteHostEntry]),
    });
    await directory.start();

    expect(directory.findById(localSnapshot.hostId)?.kind).toBe("local");
    expect(directory.findById(mockRemoteHostEntry.hostId)?.kind).toBe("remote");
    expect(directory.findById("missing")).toBeNull();
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
      const directory = new HostDirectoryService({
        runnerHost: host,
        remoteFetcher: () => Promise.resolve([mockRemoteHostEntry]),
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
      const directory = new HostDirectoryService({
        runnerHost: host,
        remoteFetcher: () => Promise.resolve(remotes),
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
      const directory = new HostDirectoryService({
        runnerHost: host,
        remoteFetcher: () => Promise.resolve(remotes),
      });
      await directory.start();

      directory.selectById(mockRemoteHostEntry.hostId);
      remotes = [];
      await directory.refresh();

      expect(directory.getSelected()).toBeNull();
    });

    it("is a no-op for an id the directory does not hold, never an unbind", async () => {
      const host = makeHost(localSnapshot);
      const directory = new HostDirectoryService({
        runnerHost: host,
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
      const directory = new HostDirectoryService({
        runnerHost: host,
        remoteFetcher: () => Promise.resolve([mockRemoteHostEntry]),
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
});
