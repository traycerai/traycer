import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { LocalHostSnapshot } from "@traycer-clients/shared/platform/runner-host";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { RemoteHostFetcher } from "@traycer-clients/shared/host-client/remote-fetcher";
import {
  HostDirectoryService,
  type HostDirectoryServiceOptions,
} from "@/lib/host/host-directory-service";
import { lastLocalHostIdKey } from "@/lib/persist";
import { useSettingsHostScopeStore } from "@/stores/settings/settings-host-scope-store";

/**
 * Mirrors `host-directory-service.test.ts`'s own `LAST_LOCAL_HOST_ID_STORAGE_KEY`
 * — the persisted key `HostDirectoryService` reads at construction
 * (`loadPersistedLocalHostId`) and writes through `adoptLocalHostId`.
 */
const LAST_LOCAL_HOST_ID_STORAGE_KEY = lastLocalHostIdKey();

/**
 * The registry's twin of "this machine" — a `kind: "remote"` row whose
 * `hostId` matches the id persisted on disk from an earlier, `hasLocalHost:
 * true` launch of this same machine. Used to prove a `hasLocalHost: false`
 * shell (mobile, or a desktop launched in the `none` lifecycle mode) never
 * treats a leftover persisted id as "mine" and rewrites this row into the
 * non-dialable local placeholder `bootingLocalEntry` produces.
 */
const PERSISTED_LOCAL_HOST_ID = "leftover-local-host-id";
const registryTwinOfPersistedId: HostDirectoryEntry = {
  hostId: PERSISTED_LOCAL_HOST_ID,
  label: "Leftover Local Host (registry copy)",
  kind: "remote",
  websocketUrl: "wss://relay.traycer.invalid/attach",
  version: "0.0.0-mock",
  transportDialability: "dialable",
};

const localSnapshot: LocalHostSnapshot = {
  hostId: "fresh-local-host-id",
  websocketUrl: "ws://127.0.0.1:4917/rpc",
  version: "1.2.3",
  pid: 4242,
  systemHostName: "hardiks-macbook",
  displayName: "hardiks-macbook",
  availability: "available",
};

function makeHost(
  hasLocalHost: boolean,
  localHost: LocalHostSnapshot | null,
): MockRunnerHost {
  return new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "http://localhost:5005",
    localHost,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost,
    traycerCli: undefined,
  });
}

const directories: HostDirectoryService[] = [];

function makeDirectory(
  options: Omit<HostDirectoryServiceOptions, "onRegistryPollTick"> &
    Partial<Pick<HostDirectoryServiceOptions, "onRegistryPollTick">>,
): HostDirectoryService {
  const directory = new HostDirectoryService({
    onRegistryPollTick: null,
    ...options,
  });
  directories.push(directory);
  return directory;
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
});

describe("HostDirectoryService with hasLocalHost: false and a persisted local host id", () => {
  it("never calls the local-host id seeder", async () => {
    window.localStorage.setItem(
      LAST_LOCAL_HOST_ID_STORAGE_KEY,
      PERSISTED_LOCAL_HOST_ID,
    );
    const host = makeHost(false, null);
    const seeder = vi.fn(() => Promise.resolve(PERSISTED_LOCAL_HOST_ID));
    const directory = makeDirectory({
      authContextId: null,
      credentialGeneration: null,
      runnerHost: host,
      localHostIdSeeder: seeder,
      remoteFetcher: null,
    });

    await directory.start();

    expect(seeder).not.toHaveBeenCalled();
    expect(directory.getLocalHostId()).toBeNull();
  });

  it("getLocalEntry() returns null", async () => {
    window.localStorage.setItem(
      LAST_LOCAL_HOST_ID_STORAGE_KEY,
      PERSISTED_LOCAL_HOST_ID,
    );
    const host = makeHost(false, null);
    const directory = makeDirectory({
      authContextId: null,
      credentialGeneration: null,
      runnerHost: host,
      localHostIdSeeder: null,
      remoteFetcher: null,
    });

    await directory.start();

    expect(directory.getLocalEntry()).toBeNull();
  });

  it("publishes the registry's twin of the persisted id under its REGISTRY (remote) kind, not rewritten into a booting-local placeholder", async () => {
    window.localStorage.setItem(
      LAST_LOCAL_HOST_ID_STORAGE_KEY,
      PERSISTED_LOCAL_HOST_ID,
    );
    const host = makeHost(false, null);
    const remoteFetcher: RemoteHostFetcher = () =>
      Promise.resolve({
        kind: "hosts",
        entries: [registryTwinOfPersistedId],
      });
    const directory = makeDirectory({
      authContextId: null,
      credentialGeneration: null,
      runnerHost: host,
      localHostIdSeeder: null,
      remoteFetcher,
    });

    await directory.start();

    const published = directory.findById(PERSISTED_LOCAL_HOST_ID);
    expect(published).not.toBeNull();
    // Unchanged shape: still the registry's own remote-kind row, with its
    // dialable websocket URL - never `bootingLocalEntry`'s `kind: "local"`,
    // `websocketUrl: null` placeholder.
    expect(published?.kind).toBe("remote");
    expect(published?.websocketUrl).toBe(
      registryTwinOfPersistedId.websocketUrl,
    );
    expect(published).toEqual(registryTwinOfPersistedId);
  });

  it("a non-null onLocalHostChange snapshot creates no local entry and adopts nothing", async () => {
    window.localStorage.setItem(
      LAST_LOCAL_HOST_ID_STORAGE_KEY,
      PERSISTED_LOCAL_HOST_ID,
    );
    const host = makeHost(false, null);
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

    // Simulates the shell delivering a live local snapshot anyway (a stray
    // event, or a bridge that fires regardless of `hasLocalHost`). A
    // `hasLocalHost: false` shell must ignore it entirely: no directory row
    // for it, and no adoption of its id as "this machine's".
    host.setLocalHost(localSnapshot);

    expect(directory.getLocalEntry()).toBeNull();
    expect(directory.getLocalHostId()).toBeNull();
    expect(directory.findById(localSnapshot.hostId)).toBeNull();
    // The handler still fires unconditionally (it always calls `emit()`),
    // but `hasLocalHost` gates both the entry projection and the id
    // adoption, so the fanned-out snapshot carries no local entry and no
    // rows moved.
    expect(changes).toEqual([{ count: 0, hasLocal: false }]);
  });

  it("does not migrate the Settings host-scope store", async () => {
    window.localStorage.setItem(
      LAST_LOCAL_HOST_ID_STORAGE_KEY,
      PERSISTED_LOCAL_HOST_ID,
    );
    // Primed as though a PREVIOUS (hasLocalHost: true) launch of this machine
    // had scoped Settings to the persisted id - the holder `adoptLocalHostId`
    // migrates when a re-enrollment fires.
    useSettingsHostScopeStore
      .getState()
      .setScopedHostId(PERSISTED_LOCAL_HOST_ID);
    const host = makeHost(false, null);
    const directory = makeDirectory({
      authContextId: null,
      credentialGeneration: null,
      runnerHost: host,
      localHostIdSeeder: null,
      remoteFetcher: null,
    });

    await directory.start();
    host.setLocalHost(localSnapshot);

    expect(useSettingsHostScopeStore.getState().scopedHostId).toBe(
      PERSISTED_LOCAL_HOST_ID,
    );
  });
});

/**
 * Emit-count parity: `hasLocalHost` changes the PAYLOAD a snapshot event
 * fans out (whether it carries a local entry), never the number of `emit()`
 * calls it triggers. The mechanism: `onLocalHostChange`'s callback inside
 * `HostDirectoryService.startSeeded` calls `this.emit()` unconditionally on
 * every snapshot, whatever `hasLocalHost` says; `adoptLocalHostId` (the id
 * seeder's resolution path) never emits at all. So a `hasLocalHost: false`
 * shell fires exactly once per snapshot too - it just reports zero entries
 * and no local host, not zero emits.
 */
async function emitsForOneSnapshot(
  hasLocalHost: boolean,
): Promise<Array<{ count: number; hasLocal: boolean }>> {
  const host = makeHost(hasLocalHost, null);
  const directory = makeDirectory({
    authContextId: null,
    credentialGeneration: null,
    runnerHost: host,
    localHostIdSeeder: null,
    remoteFetcher: null,
  });
  await directory.start();

  const records: Array<{ count: number; hasLocal: boolean }> = [];
  directory.onChange((entries, local) => {
    records.push({ count: entries.length, hasLocal: local !== null });
  });

  host.setLocalHost(localSnapshot);

  return records;
}

describe("HostDirectoryService - emit-count parity across hasLocalHost", () => {
  it("hasLocalHost: false fires one emit, reporting zero entries and no local host", async () => {
    const records = await emitsForOneSnapshot(false);
    expect(records).toEqual([{ count: 0, hasLocal: false }]);
  });

  it("hasLocalHost: true fires one emit, reporting the local entry", async () => {
    const records = await emitsForOneSnapshot(true);
    expect(records).toEqual([{ count: 1, hasLocal: true }]);
  });
});

/**
 * The control arm: identical persisted-id setup, but `hasLocalHost: true` -
 * today's existing behavior must be unchanged. Paired with the suite above so
 * a regression in either direction (the `false` arm wrongly adopting, or this
 * `true` arm silently losing its seeding/adoption/migration) is caught.
 */
describe("HostDirectoryService with hasLocalHost: true and a persisted local host id (control)", () => {
  it("calls the local-host id seeder", async () => {
    window.localStorage.setItem(
      LAST_LOCAL_HOST_ID_STORAGE_KEY,
      PERSISTED_LOCAL_HOST_ID,
    );
    const host = makeHost(true, null);
    const seeder = vi.fn(() => Promise.resolve(PERSISTED_LOCAL_HOST_ID));
    const directory = makeDirectory({
      authContextId: null,
      credentialGeneration: null,
      runnerHost: host,
      localHostIdSeeder: seeder,
      remoteFetcher: null,
    });

    await directory.start();

    expect(seeder).toHaveBeenCalled();
    expect(directory.getLocalHostId()).toBe(PERSISTED_LOCAL_HOST_ID);
  });

  it("creates a local entry from a live snapshot", async () => {
    const host = makeHost(true, localSnapshot);
    const directory = makeDirectory({
      authContextId: null,
      credentialGeneration: null,
      runnerHost: host,
      localHostIdSeeder: null,
      remoteFetcher: null,
    });

    await directory.start();

    expect(directory.getLocalEntry()?.hostId).toBe(localSnapshot.hostId);
    expect(directory.getLocalEntry()?.kind).toBe("local");
  });

  it("migrates the Settings host-scope store on re-enrollment", async () => {
    window.localStorage.setItem(
      LAST_LOCAL_HOST_ID_STORAGE_KEY,
      PERSISTED_LOCAL_HOST_ID,
    );
    useSettingsHostScopeStore
      .getState()
      .setScopedHostId(PERSISTED_LOCAL_HOST_ID);
    const host = makeHost(true, null);
    // The shell answers with a DIFFERENT id than the persisted one - a
    // re-enrollment (reinstall/replacement) discovered on this launch.
    const seeder = vi.fn(() => Promise.resolve("re-enrolled-host-id"));
    const directory = makeDirectory({
      authContextId: null,
      credentialGeneration: null,
      runnerHost: host,
      localHostIdSeeder: seeder,
      remoteFetcher: null,
    });

    await directory.start();

    expect(directory.getLocalHostId()).toBe("re-enrolled-host-id");
    expect(useSettingsHostScopeStore.getState().scopedHostId).toBe(
      "re-enrolled-host-id",
    );
  });
});
