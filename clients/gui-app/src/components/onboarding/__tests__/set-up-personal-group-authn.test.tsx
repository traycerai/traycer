import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { ReactNode } from "react";
import type { MockHandlerMap } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import type { HostRpcRegistry } from "@traycer/protocol/host";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SetUpPersonalGroup } from "@/components/onboarding/set-up-personal-group";
import { useGettingStartedChecklist } from "@/components/onboarding/getting-started-checklist";
import {
  buildEnvironmentClient,
  environmentStatusFixture,
} from "@/lib/environment/__tests__/environment-test-support";
import {
  OwnEnvironmentAuthProvider,
  createOwnEnvironmentAuthRuntime,
  installOwnEnvironmentTransport,
  jsonResponse,
  signInOwnEnvironment,
  type OwnEnvironmentAuthRuntime,
  type OwnEnvironmentRoute,
  type OwnEnvironmentTransport,
} from "@/hooks/environment/__tests__/own-environment-authn-test-support";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";

const HOST_ID = "host-onboarding";
const PERSONAL_ID = "env-personal";
const TEAM_ID = "env-team";

const hostBoundary = vi.hoisted(
  (): {
    client: HostClient<HostRpcRegistry> | null;
  } => ({ client: null }),
);

vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    useOptionalHostClient: () => hostBoundary.client,
  };
});
vi.mock("@/hooks/epics/use-cloud-epic-tasks-query", () => ({
  useCloudEpicTasksQuery: () => ({ tasks: [] }),
}));
vi.mock(
  "@/components/settings/environment/use-hosts-running-configuration",
  () => ({
    useHostsRunningPersonal: () => ({
      hosts: [],
      state: "ready",
      collisions: [],
      retry: () => undefined,
    }),
  }),
);
vi.mock("@/hooks/auth/use-auth-user-query", () => ({
  useAuthUser: () => ({ data: null }),
}));
vi.mock("@/lib/sandboxes/staged-sandbox-in-window", () => ({
  sandboxIsStagedInThisWindow: () => false,
  useStagedSandboxInThisWindow: () => null,
}));
vi.mock("@/components/settings/move/this-computer", () => ({
  useThisComputer: () => ({
    hostId: null,
    hostName: "this computer",
    client: null,
  }),
}));
vi.mock("@/components/settings/move/use-this-computers-move", () => ({
  useThisComputersMove: () => "unknown",
}));

const hostRecord = {
  hostId: HOST_ID,
  hostLabel: "window host",
  hostPlatform: "linux",
  enrolledByUserId: null,
  kind: "personal" as const,
  boundAt: null,
  reachable: true,
  lastReportedAt: null,
  applied: [],
  hasLocalRow: null,
  purgePending: false,
};

const secret = {
  secretId: "secret-1",
  name: "DEPLOY_KEY",
  kind: "api_key",
  protocol: null,
  destinations: [],
  currentVersionId: "version-1",
  revoked: false,
  updatedAt: 1,
  variables: [],
};

const personalDirectory = {
  environments: [
    {
      environmentId: PERSONAL_ID,
      ownerKind: "user",
      ownerId: "user-1",
      roomId: "room-personal",
      label: "Personal",
    },
  ],
};

const teamDirectory = {
  environments: [
    {
      environmentId: TEAM_ID,
      ownerKind: "organization",
      ownerId: "team-1",
      roomId: "room-team",
      label: "Acme",
    },
  ],
};

let runtime: OwnEnvironmentAuthRuntime;
let transport: OwnEnvironmentTransport;
let route: OwnEnvironmentRoute;

function mountGroup(
  handlers: MockHandlerMap<HostRpcRegistry>,
  hostBound = true,
): void {
  const client = hostBound
    ? buildEnvironmentClient({ hostId: HOST_ID, handlers }).client
    : null;
  hostBoundary.client = client;
  if (client !== null) {
    recordNegotiatedHostMethods(HOST_ID, [
      "environment.status",
      "providers.list",
    ]);
  }
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <OwnEnvironmentAuthProvider binding={runtime.binding}>
      <QueryClientProvider client={queryClient}>
        <SetUpPersonalGroup surface="settings" />
        <GuideSecretCard />
      </QueryClientProvider>
    </OwnEnvironmentAuthProvider>,
  );
}

function GuideSecretCard(): ReactNode {
  const checklist = useGettingStartedChecklist();
  const done = checklist.entries.find((entry) => entry.card.id === "secret")
    ?.presentation.done;
  return (
    <output data-testid="guide-secret-card">{String(done === true)}</output>
  );
}

function authnRequestsFor(path: string): string[] {
  return transport.requests
    .filter((request) => request.url.pathname.endsWith(path))
    .map((request) => request.url.pathname);
}

beforeEach(async () => {
  route = (request) => {
    const path = request.url.pathname;
    const environmentId = path.split("/")[4];
    if (path.endsWith("/hosts") && request.method === "GET") {
      return jsonResponse(200, {
        hosts:
          environmentId === PERSONAL_ID || environmentId === TEAM_ID
            ? [hostRecord]
            : [],
      });
    }
    if (path.endsWith("/members") && request.method === "GET") {
      return jsonResponse(200, { viewer: { effectiveRole: "editor" } });
    }
    if (path.endsWith("/secrets") && request.method === "GET") {
      return jsonResponse(200, { removed: [], secrets: [secret] });
    }
    return undefined;
  };
  transport = installOwnEnvironmentTransport(route, personalDirectory);
  runtime = createOwnEnvironmentAuthRuntime();
  await signInOwnEnvironment(runtime);
});

afterEach(() => {
  cleanup();
  transport.restore();
  runtime.dispose();
  hostBoundary.client = null;
  useAuthStore.setState({ status: "signed-out" });
  resetNegotiatedManifests();
});

describe("Set up Personal's secret step through authn", () => {
  it("checks a live Personal secret even when the host does not serve the secrets-list method", async () => {
    const hostSecrets: string[] = [];
    const handlers: MockHandlerMap<HostRpcRegistry> = {
      "environment.status": () =>
        environmentStatusFixture({
          principal: { kind: "personal" },
        }),
      "providers.list": () => ({ providers: [], native: null }),
      "environment.secrets.list": () => {
        hostSecrets.push("list");
        return { secrets: [], removed: [] };
      },
    };
    mountGroup(handlers);

    await waitFor(() => {
      expect(
        screen.getByTestId("set-up-personal-step").parentElement,
      ).toBeTruthy();
      expect(
        screen
          .getByTestId("set-up-personal")
          .querySelector('[data-step="secret"]')
          ?.getAttribute("data-done"),
      ).toBe("true");
      expect(screen.getByTestId("guide-secret-card").textContent).toBe("true");
    });
    expect(authnRequestsFor("/" + PERSONAL_ID + "/secrets")).toEqual([
      "/api/v3/environments/" + PERSONAL_ID + "/secrets",
    ]);
    expect(hostSecrets).toEqual([]);
  });

  it("names the host's own team environment in its onboarding secrets read", async () => {
    useAuthStore.setState({
      shareableTeams: [{ teamId: "team-1", slug: "acme", avatarUrl: null }],
    });
    const hostSecrets: string[] = [];
    const handlers: MockHandlerMap<HostRpcRegistry> = {
      "environment.status": () =>
        environmentStatusFixture({
          principal: { kind: "team", teamName: "Acme" },
        }),
      "providers.list": () => ({ providers: [], native: null }),
      "environment.secrets.list": () => {
        hostSecrets.push("list");
        return { secrets: [], removed: [] };
      },
    };
    transport.restore();
    transport = installOwnEnvironmentTransport(route, teamDirectory);
    mountGroup(handlers);

    await waitFor(() => {
      expect(
        screen
          .getByTestId("set-up-personal")
          .querySelector('[data-step="secret"]')
          ?.getAttribute("data-done"),
      ).toBe("true");
    });
    expect(authnRequestsFor("/" + TEAM_ID + "/secrets")).toEqual([
      "/api/v3/environments/" + TEAM_ID + "/secrets",
    ]);
    expect(hostSecrets).toEqual([]);
  });
  it("leaves the secret step unchecked and sends no list request without a host", async () => {
    mountGroup({}, false);

    await waitFor(() => {
      expect(screen.getByTestId("guide-secret-card").textContent).toBe("false");
    });
    expect(
      transport.requests.some((request) =>
        request.url.pathname.endsWith("/secrets"),
      ),
    ).toBe(false);
    expect(
      screen
        .getByTestId("set-up-personal")
        .querySelector('[data-step="secret"]')
        ?.getAttribute("data-done"),
    ).toBe("false");
  });

  it("checks the Guide card from the same Personal authn list as the setup step", async () => {
    const hostSecrets: string[] = [];
    const client = buildEnvironmentClient({
      hostId: HOST_ID,
      handlers: {
        "environment.status": () =>
          environmentStatusFixture({
            principal: { kind: "personal" },
          }),
        "providers.list": () => ({ providers: [], native: null }),
        "environment.secrets.list": () => {
          hostSecrets.push("list");
          return { secrets: [], removed: [] };
        },
      },
    }).client;
    hostBoundary.client = client;
    recordNegotiatedHostMethods(HOST_ID, [
      "environment.status",
      "providers.list",
    ]);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const wrapper = (props: { children: ReactNode }) => (
      <OwnEnvironmentAuthProvider binding={runtime.binding}>
        <QueryClientProvider client={queryClient}>
          {props.children}
        </QueryClientProvider>
      </OwnEnvironmentAuthProvider>
    );
    const { result } = renderHook(() => useGettingStartedChecklist(), {
      wrapper,
    });

    await waitFor(() => {
      expect(
        result.current.entries.find((entry) => entry.card.id === "secret")
          ?.presentation.done,
      ).toBe(true);
    });
    expect(authnRequestsFor("/" + PERSONAL_ID + "/secrets")).toEqual([
      "/api/v3/environments/" + PERSONAL_ID + "/secrets",
    ]);
    expect(hostSecrets).toEqual([]);
  });
});
