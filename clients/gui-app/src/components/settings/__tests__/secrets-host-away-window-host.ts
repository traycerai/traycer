import type { EnvironmentCloud } from "@traycer-clients/shared/environment/environment-cloud";
import type { EnvironmentDirectoryResult } from "@traycer-clients/shared/host-client/environment-directory";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import type { FakeEnvironmentAuthn } from "@/components/settings/environment/__tests__/environment-authn-test-support";

/**
 * The window's host client and cloud binding, and the module stand-ins that
 * hand them out. Imports types only: a `vi.mock` factory loads this module
 * while `@/lib/host` is being mocked, so a value import of it would wait on
 * itself.
 */
export const windowHost = {
  client: null as HostClient<HostRpcRegistry> | null,
  auth: null as {
    environmentCloud: () => EnvironmentCloud;
    listEnvironments: () => Promise<EnvironmentDirectoryResult>;
  } | null,
  fakeAuthn: null as FakeEnvironmentAuthn | null,
};

export const windowHostModule = {
  useHostClient: (): HostClient<HostRpcRegistry> => {
    if (windowHost.client === null) throw new Error("no window host");
    return windowHost.client;
  },
  useHostBinding: () => ({
    hostClient: windowHost.client,
    auth: windowHost.auth,
  }),
};

export const hostCredentialRefusalModule = {
  useHostCredentialRefusal: (): null => null,
};

export const hostClientForHostIdModule = {
  useHostClientForHostId: (): HostClient<HostRpcRegistry> | null =>
    windowHost.client,
};
