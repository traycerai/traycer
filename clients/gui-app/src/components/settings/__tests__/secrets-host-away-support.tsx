import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, render } from "@testing-library/react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  MockHostMessenger,
  type MockHandlerMap,
} from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { recordNegotiatedHostManifest } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { remoteEntry } from "@traycer-clients/shared/host-client/__tests__/routing-entry-fixtures";
import {
  RETIRED_PROVIDER_VARIABLES,
  RETIRED_SECRET_ROW_FIELDS,
} from "@traycer/protocol/host/released-wire-rows";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import { windowHost } from "@/components/settings/__tests__/secrets-host-away-window-host";
import { createFakeEnvironmentAuthn } from "@/components/settings/environment/__tests__/environment-authn-test-support";
import { personalHostScopeOverrides } from "@/components/settings/__tests__/environment-section-reads-fixture";
import { UngatedWindowHostAnswer } from "@/components/settings/personal/__tests__/window-host-answer";
import { PersonalPageFrame } from "@/components/settings/personal/personal-page-frame";
import { SecretsSettingsPanel } from "@/components/settings/panels/secrets-settings-panel";
import { SettingsSidebar } from "@/components/settings/settings-sidebar";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { KeybindingProvider } from "@/providers/keybinding-provider";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";

/**
 * A window whose only host is listed in the host list and is not online, and
 * the real Settings rail and the real `/settings/secrets` page over it, for
 * the suites that pin what Settings offers and draws then.
 *
 * Settings reads its window host through one scope, so the suites mock the
 * scope module with `windowHostScopeModule` and the host client hooks with
 * `windowHostModule` (a `vi.mock` factory cannot be shared, only what it
 * returns). The reads under the rail and the page are the real ones.
 */

export const HOST_ID = "host-a";
export const SECRETS_LIST = "environment.secrets.list";

const ENVIRONMENTS = {
  environments: [
    {
      environmentId: "env-personal",
      ownerKind: "user" as const,
      ownerId: "user-me",
      roomId: "room-personal",
      label: "Personal",
      effectiveRole: "owner" as const,
      kind: "personal" as const,
      hostCount: 1,
      providerHandle: null,
    },
  ],
};

/** The window's host as a remote computer with a route to it. */
export function onlineWindowHost(): HostScopeOption {
  return hostScopeOptionFixture({
    hostId: HOST_ID,
    name: "dev-box",
    isLocalMachine: false,
    entry: remoteEntry(HOST_ID, null),
  });
}

/**
 * The window's host as a remote computer that is away: listed as Offline, and
 * with no route to it, so nothing can connect.
 */
export function offlineWindowHost(): HostScopeOption {
  return hostScopeOptionFixture({
    hostId: HOST_ID,
    name: "dev-box",
    isLocalMachine: false,
    connectable: false,
    health: {
      state: "offline",
      label: "Offline",
      detail: null,
      tone: "idle",
      live: false,
    },
  });
}

/**
 * Moves the window's host from answered to away in place: it stays in the
 * scope's host list, its route goes, so the scope is unreachable and holds no
 * client, and its handshake and cached reads stay. A mock scope has no
 * subscribers, so the pick store, which the rail, the page and the window
 * host's answer all read, is set again to render them anew.
 */
export function takeWindowHostOffline(): void {
  personalHostScopeOverrides.current = {
    ...personalHostScopeOverrides.current,
    host: offlineWindowHost(),
    status: "unreachable",
    client: null,
  };
  act(() => {
    useSettingsEnvironmentPickStore.setState({ pick: { kind: "personal" } });
  });
}

/**
 * Brings the window's host back online in place, as `takeWindowHostOffline`
 * took it away, with `manifest` as what its handshake negotiated this time.
 */
export function takeWindowHostOnline(
  manifest: Readonly<Record<string, number>>,
): void {
  recordManifest(HOST_ID, manifest);
  personalHostScopeOverrides.current = {
    ...personalHostScopeOverrides.current,
    host: onlineWindowHost(),
    status: "following",
    client: windowHost.client,
  };
  act(() => {
    useSettingsEnvironmentPickStore.setState({ pick: { kind: "personal" } });
  });
}

function recordManifest(
  hostId: string,
  manifest: Readonly<Record<string, number>>,
): void {
  recordNegotiatedHostManifest(
    hostId,
    Object.fromEntries(
      Object.entries(manifest).map(([method, minor]) => [
        method,
        { major: 1, minor },
      ]),
    ),
  );
}

export function resetWindowHost(): void {
  windowHost.fakeAuthn?.restore();
  windowHost.client = null;
  windowHost.auth = null;
  windowHost.fakeAuthn = null;
  useAuthStore.setState({ status: "signed-out" });
}

export interface MountedSettings {
  readonly queryClient: QueryClient;
  readonly messenger: MockHostMessenger<HostRpcRegistry>;
}

/**
 * The rail and the Secrets page in one router, at `/settings/secrets`, with
 * `host` as the window's only host. `manifest` is what its handshake
 * negotiated: `null` records none, as for a host that never answered.
 */
export function mountSettings(options: {
  readonly host: HostScopeOption;
  readonly manifest: Readonly<Record<string, number>> | null;
  readonly handlers: MockHandlerMap<HostRpcRegistry>;
}): MountedSettings {
  const handlers: MockHandlerMap<HostRpcRegistry> = {
    "environment.list": () => ENVIRONMENTS,
    "environment.host.list": () => ({ hosts: [] }),
    "environment.configuration.items": () => ({ items: [] }),
    [SECRETS_LIST]: () => ({
      secrets: [
        {
          ...RETIRED_SECRET_ROW_FIELDS,
          providerVariables: [...RETIRED_PROVIDER_VARIABLES],
          secretId: "sec-1",
          name: "OPENAI_API_KEY",
          kind: "api_key" as const,
          protocol: "https" as const,
          destinations: ["api.example.com"],
          currentVersionId: "ver-1",
          revoked: false,
          updatedAt: 1,
          variables: [],
        },
      ],
      removed: [],
    }),
    ...options.handlers,
  };
  const fakeAuthn = createFakeEnvironmentAuthn(handlers);
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => "req-away",
    handlers,
  });
  const entry = remoteEntry(options.host.hostId, null);
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => undefined },
    findHostById: (hostId) => (hostId === entry.hostId ? entry : null),
    messenger,
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  const client = spine.createRequester(entry);
  windowHost.client = client;
  windowHost.fakeAuthn = fakeAuthn;
  windowHost.auth = {
    environmentCloud: () => fakeAuthn.cloud,
    listEnvironments: () =>
      Promise.resolve({ kind: "ok" as const, list: ENVIRONMENTS }),
  };
  if (options.manifest !== null) {
    recordManifest(options.host.hostId, options.manifest);
  }
  personalHostScopeOverrides.current = {
    host: options.host,
    hostId: options.host.hostId,
    status: options.host.connectable ? "following" : "unreachable",
    client: options.host.connectable ? client : null,
  };
  useAuthStore.setState({ status: "signed-in" });

  const rootRoute = createRootRoute({
    component: () => (
      <>
        <SettingsSidebar mode={{ kind: "route" }} variant="rail" />
        <UngatedWindowHostAnswer>
          <PersonalPageFrame section="secrets">
            <SecretsSettingsPanel />
          </PersonalPageFrame>
        </UngatedWindowHostAnswer>
      </>
    ),
  });
  const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings/$section",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([settingsRoute]),
    history: createMemoryHistory({ initialEntries: ["/settings/secrets"] }),
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const runnerHost = new MockRunnerHost({
    signInUrl: "https://example.invalid/signin",
    authnBaseUrl: "https://example.invalid",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={runnerHost}>
        <KeybindingProvider router={router}>
          <RouterProvider router={router} />
        </KeybindingProvider>
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
  return { messenger, queryClient };
}
