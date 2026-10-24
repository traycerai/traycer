import { useEffect, useState, type ReactNode } from "react";
import { QueryClient } from "@tanstack/react-query";
import { HostRuntime } from "@traycer-clients/shared/host-client/host-runtime";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { hostRpcRegistry, type HostRpcRegistry } from "@traycer/protocol/host";
import { AuthService } from "@/lib/auth/auth-service";
import { createAuthBoundHostDirectory } from "@/lib/host/auth-bound-host-directory";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { HostRuntimeContext } from "@/lib/host/runtime";
import type { HostRuntimeBinding } from "@/providers/host-runtime-provider";

/**
 * The app's host runtime, composed the way the app composes it (real auth,
 * directory and runtime) over a signed-out runner host and a messenger with no
 * handlers. Nothing is started and no host is effective, so every host request
 * rejects with the preflight error and every surface below renders its
 * no-host state - what a window shows before its host comes up.
 */
function buildBinding(): HostRuntimeBinding<HostRpcRegistry> {
  const runnerHost = new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "https://authn.traycer.invalid",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  const auth = new AuthService({ runnerHost });
  const directory = createAuthBoundHostDirectory({
    auth,
    runnerHost,
    remoteFetcher: null,
    localHostIdSeeder: () => Promise.resolve(null),
    onRegistryPollTick: null,
  });
  let requestSeq = 0;
  const runtime = new HostRuntime<HostRpcRegistry>({
    runnerHost,
    registry: hostRpcRegistry,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => `test-runtime-${++requestSeq}`,
      handlers: {},
    }),
    requestContextProvider: auth.getRequestContextProvider(),
    directory,
    invalidator: createHostQueryInvalidator(
      new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    ),
    schedulingPolicy: hostRpcSchedulingPolicy,
    authorityRegistry: null,
    requestCoordinator: null,
    selectedHostId: () => null,
    connectionRegistry: null,
  });
  return {
    runtime,
    hostClient: runtime.hostClient,
    directory,
    auth,
    hostId: null,
  };
}

export function HostRuntimeTestProvider(props: {
  readonly children: ReactNode;
}): ReactNode {
  const [binding] = useState(buildBinding);
  useEffect(
    () => () => {
      binding.runtime.dispose();
      binding.directory.dispose();
      binding.auth.dispose();
    },
    [binding],
  );
  return (
    <HostRuntimeContext.Provider value={binding}>
      {props.children}
    </HostRuntimeContext.Provider>
  );
}
