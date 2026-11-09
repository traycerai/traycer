import { useLayoutEffect, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { recordNegotiatedHostManifest } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { SandboxesSettingsPanel } from "@/components/settings/panels/sandboxes-settings-panel";
import { TooltipProvider } from "@/components/ui/tooltip";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import { useSandboxList } from "@/hooks/sandboxes/use-sandbox-list-query";
import {
  HostRuntimeProvider,
  hostRpcRegistry,
  useHostBinding,
  type HostRpcRegistry,
  type MessengerFactory,
} from "@/lib/host";
import { sandboxQueryKeys } from "@/lib/query-keys";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { ThemeProvider } from "@/providers/theme-provider";
import { useSettingsStore } from "@/stores/settings/settings-store";
import "@/lib/theme-applier";
import "@/index.css";

const rows = [
  sandboxSummaryFixture({
    id: "settings-failure",
    hostId: "fixture-settings-failure",
    displayName: "Sandbox — environment settings could not be applied",
    guestConfigured: false,
    createdByTaskTitle: "Windows acceptance and integration checks",
  }),
  sandboxSummaryFixture({
    id: "healthy-suspended",
    hostId: "fixture-suspended",
    displayName: "Sandbox — suspended acceptance workload",
    state: "suspended",
    guestConfigured: true,
    createdByTaskTitle: "Windows acceptance and integration checks",
  }),
];

useSettingsStore.setState({ uiFontSize: 16 });
recordNegotiatedHostManifest("fixture-settings-failure", {
  "host.sandbox.repairGuestConfiguration": { major: 1, minor: 1 },
});

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, staleTime: Infinity },
    mutations: { retry: false },
  },
});
const runnerHost = new MockRunnerHost({
  signInUrl: "http://127.0.0.1:9/sign-in",
  authnBaseUrl: "http://127.0.0.1:9",
  localHost: null,
  hosts: [],
  workspaceFolderPickerPaths: undefined,
  hasLocalHost: undefined,
  traycerCli: undefined,
});
let requestId = 0;
const messengerFactory: MessengerFactory<HostRpcRegistry> = ({ registry }) =>
  new MockHostMessenger<HostRpcRegistry>({
    registry,
    requestId: () => `sandbox-layout-${String(++requestId)}`,
    handlers: {},
  });

export function PreparedPanel(): ReactNode {
  const binding = useHostBinding();
  const list = useSandboxList();
  useLayoutEffect(() => {
    if (binding === null) return;
    // Signed-out queries consume prepared data without any account or host I/O.
    queryClient.setQueryData(sandboxQueryKeys.list(binding.auth, null), {
      sandboxes: rows,
    });
    queryClient.setQueryData(
      sandboxQueryKeys.automation(binding.auth, null, null),
      { available: false, sandbox: null, pods: [] },
    );
    queryClient.setQueryData(
      sandboxQueryKeys.catalogue(binding.auth, null, null),
      { providers: [] },
    );
  }, [binding]);
  // Reserve the desktop navigation share; phones use the full settings pane.
  return list.data !== undefined ? (
    <main className="ml-auto w-full lg:w-3/5">
      <SandboxesSettingsPanel />
    </main>
  ) : null;
}

const rootRoute = createRootRoute({
  component: () => (
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={runnerHost}>
        <HostRuntimeProvider
          registry={hostRpcRegistry}
          messengerFactory={messengerFactory}
          invalidator={null}
          requestId={null}
          remoteFetcher={() => Promise.resolve({ kind: "hosts", entries: [] })}
          fallback={null}
        >
          <ThemeProvider>
            <TooltipProvider>
              <PreparedPanel />
            </TooltipProvider>
          </ThemeProvider>
        </HostRuntimeProvider>
      </RunnerHostProvider>
    </QueryClientProvider>
  ),
});
const router = createRouter({
  routeTree: rootRoute,
  history: createMemoryHistory({ initialEntries: ["/"] }),
});
const container = document.getElementById("root");
if (container === null) throw new Error("Missing sandbox layout fixture root");
createRoot(container).render(<RouterProvider router={router} />);
