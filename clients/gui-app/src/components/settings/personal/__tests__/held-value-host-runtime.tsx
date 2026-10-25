import type { ReactNode } from "react";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import {
  HostRuntimeProvider,
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@/lib/host";
import { RunnerHostProvider } from "@/providers/runner-host-provider";

/**
 * The host runtime a held value's `Review` needs to open its sheet (the
 * directory and the runner), around a page whose own client the suite mocks.
 */
export function HeldValueHostRuntime(props: {
  readonly children: ReactNode;
}): ReactNode {
  return (
    <RunnerHostProvider
      runnerHost={
        new MockRunnerHost({
          signInUrl: "https://auth.traycer.invalid/sign-in",
          authnBaseUrl: "https://authn.traycer.invalid",
          localHost: null,
          hosts: [],
          workspaceFolderPickerPaths: undefined,
          hasLocalHost: undefined,
          traycerCli: undefined,
        })
      }
    >
      <HostRuntimeProvider
        registry={hostRpcRegistry}
        messengerFactory={(args) =>
          new MockHostMessenger<HostRpcRegistry>({
            registry: args.registry,
            requestId: () => "req-runtime",
            handlers: {},
          })
        }
        invalidator={null}
        requestId={null}
        remoteFetcher={() => Promise.resolve({ kind: "hosts", entries: [] })}
        fallback={null}
      >
        {props.children}
      </HostRuntimeProvider>
    </RunnerHostProvider>
  );
}
