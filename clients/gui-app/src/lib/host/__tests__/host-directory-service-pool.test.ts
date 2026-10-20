import { afterEach, describe, expect, it } from "vitest";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import {
  POOL_HOST_ID,
  type HostDirectoryEntry,
} from "@traycer-clients/shared/host-client/host-directory";
import type { RemoteHostFetcher } from "@traycer-clients/shared/host-client/remote-fetcher";
import { HostDirectoryService } from "@/lib/host/host-directory-service";
import { useSettingsHostScopeStore } from "@/stores/settings/settings-host-scope-store";

/**
 * The server pool is resolved by id and never enumerated: it is addressable
 * wherever a requester looks a host up, and absent from every list a person
 * picks from or a sweep walks. The pool entry comes from the shell's own
 * `runnerHost.poolBaseUrl`.
 */

const POOL_URL = "wss://pool.test/v1/session";

class PoolConfiguredRunnerHost extends MockRunnerHost {
  override readonly poolBaseUrl: string;

  constructor(poolBaseUrl: string) {
    super({
      signInUrl: "https://auth.traycer.invalid/sign-in",
      authnBaseUrl: "http://localhost:5005",
      localHost: null,
      hosts: [],
      workspaceFolderPickerPaths: undefined,
      hasLocalHost: false,
      traycerCli: undefined,
    });
    this.poolBaseUrl = poolBaseUrl;
  }
}

const REGISTRY_HOST: HostDirectoryEntry = {
  hostId: "host-registry",
  label: "A registered host",
  kind: "remote",
  websocketUrl: "wss://relay.traycer.invalid/attach",
  version: "1.5.0",
  transportDialability: "dialable",
};

const directories: HostDirectoryService[] = [];

async function startedDirectory(
  poolBaseUrl: string,
  registry: readonly HostDirectoryEntry[],
): Promise<HostDirectoryService> {
  const remoteFetcher: RemoteHostFetcher = () =>
    Promise.resolve({ kind: "hosts", entries: registry });
  const directory = new HostDirectoryService({
    onRegistryPollTick: null,
    authContextId: null,
    credentialGeneration: null,
    runnerHost: new PoolConfiguredRunnerHost(poolBaseUrl),
    localHostIdSeeder: null,
    remoteFetcher,
  });
  directories.push(directory);
  await directory.start();
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    directory.dispose();
  }
  useSettingsHostScopeStore.getState().setScopedHostId(null);
});

describe("HostDirectoryService and the server pool", () => {
  it("resolves the pool by id from the configured address, and lists only hosts", async () => {
    const directory = await startedDirectory(POOL_URL, [REGISTRY_HOST]);

    const pool = directory.findById(POOL_HOST_ID);
    expect(pool).toMatchObject({
      hostId: POOL_HOST_ID,
      kind: "pool",
      websocketUrl: POOL_URL,
    });
    expect(directory.findById(REGISTRY_HOST.hostId)?.kind).toBe("remote");

    const listed = await directory.list();
    expect(listed.map((entry) => entry.hostId)).toEqual([REGISTRY_HOST.hostId]);
    expect(directory.getCardinality()).toBe("one");
    expect(directory.getDefaultEntry()?.hostId).toBe(REGISTRY_HOST.hostId);
    expect(directory.knownHostIds() ?? []).not.toContain(POOL_HOST_ID);
  });

  it("keeps an otherwise empty fleet empty when the pool is configured", async () => {
    const directory = await startedDirectory(POOL_URL, []);

    expect(directory.findById(POOL_HOST_ID)).not.toBeNull();
    expect(await directory.list()).toEqual([]);
    expect(directory.getCardinality()).toBe("zero");
    expect(directory.getDefaultEntry()).toBeNull();
  });

  it("synthesizes no pool entry when the build has no pool address", async () => {
    const directory = await startedDirectory("", [REGISTRY_HOST]);

    expect(directory.findById(POOL_HOST_ID)).toBeNull();
    expect((await directory.list()).map((entry) => entry.hostId)).toEqual([
      REGISTRY_HOST.hostId,
    ]);
  });
});
