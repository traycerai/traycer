import {
  installHostConnectionRegistrySource,
  resetHostConnectionRegistryForTest,
} from "@traycer-clients/shared/host-client/host-connection-registry";
import { remoteEntry } from "@traycer-clients/shared/host-client/__tests__/routing-entry-fixtures";
import type { RemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import { createFakeRunnerHost } from "../../../../__tests__/create-fake-runner-host";
import { HostDirectoryService } from "@/lib/host/host-directory-service";

export interface HostUpdateGestureDirectory {
  readonly directory: HostDirectoryService;
  readonly refreshVersions: (
    appVersion: string,
    entryVersion: string,
  ) => Promise<void>;
  readonly dispose: () => void;
}

export async function installHostUpdateGestureDirectory(
  hostId: string,
  initialAppVersion: string,
  initialEntryVersion: string,
): Promise<HostUpdateGestureDirectory> {
  let row = remoteRow(hostId, initialAppVersion, initialEntryVersion);
  const directory = new HostDirectoryService({
    runnerHost: createFakeRunnerHost({ hasLocalHost: false }),
    remoteFetcher: () => Promise.resolve({ kind: "hosts", entries: [row] }),
    localHostIdSeeder: () => Promise.resolve(null),
    onRegistryPollTick: null,
    authContextId: () => "user-1",
    credentialGeneration: () => 1,
  });
  await directory.refresh();
  installHostConnectionRegistrySource({
    directory: {
      findById: (requestedHostId) => directory.findById(requestedHostId),
      onDirectoryChanged: (listener) => {
        const subscription = directory.onChange(() => listener());
        return { dispose: () => subscription.dispose() };
      },
    },
    leases: null,
  });

  return {
    directory,
    refreshVersions: async (appVersion, entryVersion) => {
      row = remoteRow(hostId, appVersion, entryVersion);
      await directory.refresh();
    },
    dispose: () => {
      resetHostConnectionRegistryForTest();
      directory.dispose();
    },
  };
}

function remoteRow(
  hostId: string,
  appVersion: string,
  entryVersion: string,
): RemoteHostDirectoryEntry {
  const base = remoteEntry(hostId, null);
  return {
    ...base,
    version: entryVersion,
    remoteStatus: { ...base.remoteStatus, appVersion },
  };
}
