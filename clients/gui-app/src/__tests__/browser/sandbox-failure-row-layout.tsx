import { useEffect, useState, type ReactNode } from "react";
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
import type { SandboxCatalogueReadinessRequest } from "@traycer/protocol/host/sandbox-control";
import type { EnvironmentDescriptorV11 } from "@traycer/protocol/host/environment/contracts";
import { credentialsIdentityFromAuthenticatedUser } from "@traycer-clients/shared/auth/auth-validation";
import type { AuthIdentityValidationResult } from "@traycer-clients/shared/auth/auth-validation-types";
import type { EnvironmentDirectoryResult } from "@traycer-clients/shared/host-client/environment-directory";
import type {
  SandboxAutomationFetchResult,
  SandboxCatalogueFetchResult,
  SandboxCostsFetchResult,
  SandboxListFetchResult,
} from "@traycer-clients/shared/host-client/sandbox-control";
import { createAuthenticatedUserFixture } from "@traycer-clients/shared/test-fixtures/authenticated-user";
import { createFakeEnvironmentCloudTransport } from "../../../__tests__/create-fake-runner-host";
import { SandboxesSettingsPanel } from "@/components/settings/panels/sandboxes-settings-panel";
import { TooltipProvider } from "@/components/ui/tooltip";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import { useSandboxList } from "@/hooks/sandboxes/use-sandbox-list-query";
import {
  HostRuntimeProvider,
  hostRpcRegistry,
  type HostRpcRegistry,
  type MessengerFactory,
} from "@/lib/host";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { ThemeProvider } from "@/providers/theme-provider";
import { useSettingsStore } from "@/stores/settings/settings-store";
import "@/lib/theme-applier";
import "@/index.css";

const FIXTURE_TOKEN = "sandbox-layout-fixture-token";
const AUTHN_BASE_URL = "http://127.0.0.1:9";
const USER = createAuthenticatedUserFixture(undefined);
const PERSONAL_ENVIRONMENT: EnvironmentDescriptorV11 = {
  environmentId: "sandbox-layout-personal",
  ownerKind: "user",
  ownerId: USER.user.id,
  roomId: "sandbox-layout-personal-room",
  label: "Personal",
  effectiveRole: "owner",
  kind: "personal",
  hostCount: 0,
  providerHandle: null,
};

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
/** The real AuthService and queries read one coherent fixture account. */
class SandboxLayoutRunnerHost extends MockRunnerHost {
  override readonly environmentTransport = createFakeEnvironmentCloudTransport({
    environments: () => [PERSONAL_ENVIRONMENT],
  });

  override validateAuthTokenIdentity(
    token: string,
  ): Promise<AuthIdentityValidationResult> {
    return Promise.resolve(
      token === FIXTURE_TOKEN
        ? { kind: "valid", user: USER }
        : { kind: "rejected" },
    );
  }

  override listEnvironments(
    bearerToken: string,
  ): Promise<EnvironmentDirectoryResult> {
    return Promise.resolve(
      bearerToken === FIXTURE_TOKEN
        ? { kind: "ok", list: { environments: [PERSONAL_ENVIRONMENT] } }
        : { kind: "unauthorized" },
    );
  }

  override listSandboxes(bearerToken: string): Promise<SandboxListFetchResult> {
    return Promise.resolve(
      bearerToken === FIXTURE_TOKEN
        ? { kind: "ok", response: { sandboxes: rows } }
        : { kind: "unauthorized" },
    );
  }

  override getSandboxCatalogue(
    bearerToken: string,
    _context: SandboxCatalogueReadinessRequest | null,
  ): Promise<SandboxCatalogueFetchResult> {
    return Promise.resolve(
      bearerToken === FIXTURE_TOKEN
        ? { kind: "ok", catalogue: { providers: [] } }
        : { kind: "unauthorized" },
    );
  }

  override getSandboxAutomation(
    bearerToken: string,
    _environmentId: string | null,
  ): Promise<SandboxAutomationFetchResult> {
    return Promise.resolve(
      bearerToken === FIXTURE_TOKEN
        ? {
            kind: "ok",
            automation: { available: false, sandbox: null, pods: [] },
          }
        : { kind: "unauthorized" },
    );
  }

  override getSandboxCosts(
    bearerToken: string,
  ): Promise<SandboxCostsFetchResult> {
    return Promise.resolve(
      bearerToken === FIXTURE_TOKEN
        ? {
            kind: "ok",
            costs: {
              sandboxes: [],
              awakeBurnMillicreditsPerHour: 0,
              todayYoursMillicredits: 0,
              todayByEnvironment: [],
            },
          }
        : { kind: "unauthorized" },
    );
  }
}

const runnerHost = new SandboxLayoutRunnerHost({
  signInUrl: `${AUTHN_BASE_URL}/sign-in`,
  authnBaseUrl: AUTHN_BASE_URL,
  localHost: null,
  hosts: [],
  workspaceFolderPickerPaths: undefined,
  hasLocalHost: undefined,
  traycerCli: undefined,
});
const storedSession = runnerHost.tokenStore.signIn(
  { token: FIXTURE_TOKEN, refreshToken: "sandbox-layout-fixture-refresh" },
  credentialsIdentityFromAuthenticatedUser(USER),
);

let requestId = 0;
const messengerFactory: MessengerFactory<HostRpcRegistry> = ({ registry }) =>
  new MockHostMessenger<HostRpcRegistry>({
    registry,
    requestId: () => `sandbox-layout-${String(++requestId)}`,
    handlers: {},
  });

export function PreparedPanel(): ReactNode {
  const list = useSandboxList();
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
function SandboxLayoutFixture(): ReactNode {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let disposed = false;
    void storedSession.then(() => {
      if (!disposed) setReady(true);
    });
    return () => {
      disposed = true;
    };
  }, []);
  return ready ? <RouterProvider router={router} /> : null;
}

createRoot(container).render(<SandboxLayoutFixture />);
