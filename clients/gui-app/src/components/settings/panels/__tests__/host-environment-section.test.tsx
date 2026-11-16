/** The Overview's settings source row, including the legacy team state. */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import {
  MockHostMessenger,
  type MockHandlerMap,
} from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type {
  EnvironmentDescriptor,
  EnvironmentDescriptorV11,
  EnvironmentHostBinding,
} from "@traycer/protocol/host/environment/contracts";
import type { AuthEra } from "@traycer-clients/shared/auth/request-context-provider";
import type {
  EnvironmentTransportAnswer,
  EnvironmentTransportRequest,
} from "@traycer-clients/shared/environment/environment-cloud";
import type { AuthService } from "@/lib/auth/auth-service";
import { authQueryKeys } from "@/lib/query-keys";
import { TEAM_TRANSFER_DISCLOSURE } from "@traycer/protocol/host/environment/team-transfer-disclosure";
import type { HostOwnershipResult } from "@traycer-clients/shared/host-client/host-ownership";
import type { TeamComputerReleaseResult } from "@traycer-clients/shared/host-client/team-computer-release";
import type {
  HostListItem,
  HostOwnerPrincipal,
} from "@traycer/protocol/host/host-status";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import {
  hostScopeFixture,
  hostScopeOptionFixture,
} from "@/components/settings/host-scope/host-scope-fixture";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { environmentStatusFixture } from "@/lib/environment/__tests__/environment-test-support";
import type {
  EnvironmentStatusResponseV11,
  EnvironmentStatusResponseV13,
} from "@traycer/protocol/host/environment-schemas";
import type {
  EnvironmentMovePlanRequestV20,
  EnvironmentMoveStageRequest,
  EnvironmentMoveStartRequest,
} from "@traycer/protocol/host/environment/move-contracts";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import {
  mountTeamPage,
  poolSource,
  resetTeamPageHarness,
  setTeamEnvironmentCloudOverride,
  teamHostBoundary,
} from "@/components/settings/environment/__tests__/team-configuration-test-support";
import {
  GIVE_ACCEPTANCE_ID,
  GIVE_ATTEMPT_ID,
  GIVE_DISCLOSURE_HASH,
  GIVE_PLAN,
  GIVE_PLAN_HASH,
  GIVE_TEAM_ID,
  giveMoveStatus,
  giveStageFixture,
} from "@/components/settings/panels/__tests__/team-give-test-support";

const PERSONAL: EnvironmentDescriptor = {
  environmentId: "env-personal",
  ownerKind: "user",
  ownerId: "user-me",
  roomId: "room-personal",
  label: "Personal",
};

const TEAM: EnvironmentDescriptor = {
  environmentId: "env-team",
  ownerKind: "organization",
  ownerId: GIVE_TEAM_ID,
  roomId: "room-team",
  label: "Acme",
};

function listedEnvironment(
  environment: EnvironmentDescriptor,
): EnvironmentDescriptorV11 {
  return {
    ...environment,
    effectiveRole: "owner",
    kind: environment.ownerKind === "user" ? "personal" : "team",
    hostCount: 0,
    providerHandle: null,
  };
}

const mocks = vi.hoisted(() => ({
  state: {
    binding: null as EnvironmentHostBinding | null,
    status: null as EnvironmentStatusResponseV11 | null,
    teamRole: "editor",
    environmentListFails: false,
    /** The rendered host's client, which a request named for its id reaches. */
    client: null as HostClient<HostRpcRegistry> | null,
  },
  auth: {
    currentAuthEra: vi.fn<() => AuthEra>(),
    readHostOwnership:
      vi.fn<(hostId: string, era: AuthEra) => Promise<HostOwnershipResult>>(),
    releaseTeamComputer:
      vi.fn<
        (
          hostId: string,
          environmentId: string,
        ) => Promise<TeamComputerReleaseResult>
      >(),
    listEnvironments: vi.fn<AuthService["listEnvironments"]>(),
    environmentCloud: vi.fn<AuthService["environmentCloud"]>(),
  },
  refreshDirectory: vi.fn<() => Promise<unknown>>(),
}));
const noteHostMembershipChanged = vi.hoisted(() =>
  vi.fn<(hostId: string) => void>(),
);

vi.mock("@/lib/host/local-admission-invalidation", () => ({
  noteHostMembershipChanged,
}));

vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostBinding: () => ({
      auth: mocks.auth,
      directory: { refresh: mocks.refreshDirectory },
    }),
  };
});

// A request named for the rendered host goes out on that host's own client.
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) =>
    hostId === "host-a" ? mocks.state.client : null,
}));
vi.mock("@/hooks/bots/use-environment-host-read-query", () => ({
  useEnvironmentHostReadQuery: () => ({
    kind: "binding",
    query: { isError: false, data: mocks.state.binding ?? undefined },
  }),
}));
// The list is the account's, read through authn rather than this host's
// `environment.list`; the person's role on the team is all the card reads.
vi.mock("@/hooks/bots/use-environment-list-query", async () => {
  const { useQuery } = await import("@tanstack/react-query");
  return {
    useEnvironmentListQuery: (enabled: boolean) =>
      useQuery({
        queryKey: ["environment-list-fixture", mocks.state.teamRole],
        queryFn: () => {
          if (mocks.state.environmentListFails)
            throw new Error("The account environment list could not be read.");
          return {
            environments: [
              listedEnvironment(PERSONAL),
              {
                ...listedEnvironment(TEAM),
                effectiveRole: mocks.state.teamRole,
              },
            ],
          };
        },
        enabled,
      }),
  };
});
vi.mock("@/hooks/environment/use-environment-reads", () => ({
  useEnvironmentStatusRead: () => ({ data: mocks.state.status }),
}));
import { HostEnvironmentSection } from "@/components/settings/panels/host-environment-section";
import { useAuthStore } from "@/stores/auth/auth-store";
import { RunnerHostContext } from "@/providers/runner-host-context";
import { dashboardRunnerHost } from "@/components/settings/host-scope/__tests__/host-access-test-support";

function makeClient(
  handlers: MockHandlerMap<HostRpcRegistry> | undefined,
): HostClient<HostRpcRegistry> {
  const localHost = { ...mockLocalHostEntry, hostId: "host-a" };
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => undefined },
    findHostById: (hostId) => (hostId === localHost.hostId ? localHost : null),
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: handlers ?? {},
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  return spine.createRequester(localHost);
}

const PERSON_OWNER: HostOwnerPrincipal = { kind: "user", id: "user-me" };
const TEAM_OWNER: HostOwnerPrincipal = {
  kind: "team",
  id: GIVE_TEAM_ID,
  name: "Acme",
};
const NO_SECTION_OPTIONS = {
  owner: undefined,
  isLocalMachine: undefined,
  handlers: undefined,
} as const;

function registryItem(owner: HostOwnerPrincipal | undefined): HostListItem {
  const row: HostListItem = {
    hostId: "host-a",
    displayName: "Mac mini",
    platform: "darwin-arm64",
    kind: "personal",
    publicKey: "pk",
    createdAt: "2026-01-01T00:00:00Z",
    updatePolicy: "manual",
    status: {
      connectivity: "connectable",
      viewerReachability: "unknown",
      clientCloud: "ok",
      updateState: "current",
      appVersion: "1.5.0",
      lastSeenAt: "2026-01-01T00:00:00Z",
    },
  };
  return owner === undefined ? row : { ...row, owner };
}

function renderSection(
  kind: "personal" | "sandbox",
  options: {
    readonly owner: HostOwnerPrincipal | undefined;
    readonly isLocalMachine: boolean | undefined;
    readonly handlers: MockHandlerMap<HostRpcRegistry> | undefined;
    readonly runnerHost?: IRunnerHost;
  },
): QueryClient {
  const handlers: MockHandlerMap<HostRpcRegistry> = {
    "environment.list": () => ({
      environments: [
        listedEnvironment(PERSONAL),
        { ...listedEnvironment(TEAM), effectiveRole: "editor" },
      ],
    }),
    ...options.handlers,
  };
  const teamPage = mountTeamPage(poolSource("editor"), handlers);
  mocks.auth.listEnvironments.mockImplementation(() =>
    teamPage.auth.listEnvironments(),
  );
  mocks.auth.environmentCloud.mockImplementation(() =>
    teamPage.auth.environmentCloud(),
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const client = makeClient(handlers);
  mocks.state.client = client;
  render(
    <QueryClientProvider client={queryClient}>
      <RunnerHostContext.Provider
        value={options.runnerHost ?? dashboardRunnerHost()}
      >
        <HostEnvironmentSection
          hostName="Mac mini"
          scope={hostScopeFixture({
            host: hostScopeOptionFixture({
              hostId: "host-a",
              name: "Mac mini",
              kind,
              isLocalMachine: options.isLocalMachine ?? true,
              item:
                options.isLocalMachine === false && options.owner !== undefined
                  ? registryItem(options.owner)
                  : null,
              sandbox:
                kind === "sandbox"
                  ? {
                      state: "awake",
                      frozen: false,
                      summary: sandboxSummaryFixture({ hostId: "host-a" }),
                      ownerKind: "unknown",
                      teamOwned: false,
                    }
                  : null,
            }),
            client,
          })}
        />
      </RunnerHostContext.Provider>
    </QueryClientProvider>,
  );
  return queryClient;
}

function teamBinding(canUnbind: boolean): EnvironmentHostBinding {
  return {
    hostId: "host-a",
    environment: TEAM,
    explicit: true,
    enrolledByUserId: "user-enroller",
    canUnbind,
  };
}

function ownershipResult(
  owner: HostOwnerPrincipal | undefined,
): HostOwnershipResult {
  return owner === undefined
    ? { kind: "network-error" }
    : {
        kind: "ok",
        host: {
          hostId: "host-a",
          owner,
          kind: "personal",
          remoteAccess: false,
        },
      };
}

const GIVE_STAGE = giveStageFixture({
  hostId: "host-a",
  environmentId: TEAM.environmentId,
  teamId: GIVE_TEAM_ID,
});

interface GiveCalls {
  readonly plans: EnvironmentMovePlanRequestV20[];
  readonly stages: EnvironmentMoveStageRequest[];
  readonly starts: EnvironmentMoveStartRequest[];
}

function giveCalls(): GiveCalls {
  return { plans: [], stages: [], starts: [] };
}

function giveHostHandlers(
  calls: GiveCalls,
  events: string[],
): MockHandlerMap<HostRpcRegistry> {
  return {
    "environment.move.plan": (request) => {
      events.push("plan");
      calls.plans.push(request);
      return GIVE_PLAN;
    },
    "environment.move.stage": (request) => {
      events.push("stage");
      calls.stages.push(request);
      return GIVE_STAGE;
    },
    "environment.move.start": (request) => {
      events.push("start");
      calls.starts.push(request);
      return {
        state: "running",
        attemptId: GIVE_ATTEMPT_ID,
        acceptanceId: GIVE_ACCEPTANCE_ID,
      };
    },
    "environment.status": () => {
      events.push("status:done");
      return giveMoveStatus("done", GIVE_ATTEMPT_ID);
    },
    "environment.previewLocalFacts": () => ({ activeTurns: 0, terminals: 0 }),
  };
}

function giveNegotiatedHostMethods(): void {
  recordNegotiatedHostManifest("host-a", {
    "environment.list": { major: 1, minor: 1 },
    "environment.status": { major: 1, minor: 3 },
    "environment.host.read": { major: 1, minor: 1 },
    "environment.move.plan": { major: 2, minor: 0 },
    "environment.move.stage": { major: 1, minor: 0 },
    "environment.move.start": { major: 1, minor: 0 },
    "environment.previewLocalFacts": { major: 1, minor: 0 },
    "environment.move.stopPreview": { major: 1, minor: 0 },
    "environment.move.stop": { major: 1, minor: 0 },
  });
}

function installGiveAcceptanceTransport(
  isOriginSignIn: () => boolean,
  events: string[],
): EnvironmentTransportRequest[] {
  const auth = teamHostBoundary.auth;
  if (auth === null) throw new Error("The team auth fixture is unavailable");
  const cloud = auth.environmentCloud();
  const requests: EnvironmentTransportRequest[] = [];
  setTeamEnvironmentCloudOverride({
    ...cloud,
    onOriginSignIn: isOriginSignIn,
    transport: async (request): Promise<EnvironmentTransportAnswer> => {
      requests.push(request);
      if (
        request.method === "POST" &&
        new URL(request.url).pathname ===
          "/api/v3/hosts/host-a/move-acceptances"
      ) {
        events.push("acceptance");
        return {
          status: 201,
          text: JSON.stringify({ acceptanceId: GIVE_ACCEPTANCE_ID }),
        };
      }
      return cloud.transport(request);
    },
  });
  return requests;
}

async function openGiveDialog(
  calls: GiveCalls,
  events: string[],
): Promise<QueryClient> {
  giveNegotiatedHostMethods();
  const queryClient = renderSection("personal", {
    owner: PERSON_OWNER,
    isLocalMachine: true,
    handlers: giveHostHandlers(calls, events),
  });
  await waitFor(() => {
    expect(
      queryClient.getQueryState(
        authQueryKeys.hostOwnership(mocks.auth, "user-me", "host-a"),
      )?.status,
    ).toBe("success");
  });
  const selector = screen.getByRole("combobox", { name: "Environment" });
  fireEvent.keyDown(selector, { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("option", { name: /Acme/ }));
  const dialog = await screen.findByRole("dialog");
  await waitFor(() => {
    expect(
      within(dialog)
        .getByRole("button", { name: "Confirm at this computer" })
        .hasAttribute("disabled"),
    ).toBe(false);
  });
  return queryClient;
}

function giveReadbackKey(): readonly unknown[] {
  return authQueryKeys.hostOwnershipAfterMove(
    mocks.auth,
    "user-me",
    "host-a",
    GIVE_ATTEMPT_ID,
  );
}

beforeEach(() => {
  mocks.state.teamRole = "editor";
  mocks.state.environmentListFails = false;
  mocks.state.client = null;
  mocks.auth.currentAuthEra.mockReset();
  mocks.auth.currentAuthEra.mockReturnValue({
    identity: "user-me",
    credentialGeneration: 1,
  });
  mocks.auth.readHostOwnership.mockReset();
  mocks.auth.readHostOwnership.mockResolvedValue(ownershipResult(PERSON_OWNER));
  mocks.auth.releaseTeamComputer.mockReset();
  mocks.auth.releaseTeamComputer.mockResolvedValue({ kind: "ok" });
  mocks.auth.listEnvironments.mockReset();
  mocks.auth.environmentCloud.mockReset();
  noteHostMembershipChanged.mockReset();
  mocks.refreshDirectory.mockReset();
  mocks.refreshDirectory.mockResolvedValue(undefined);
  recordNegotiatedHostManifest("host-a", {
    "environment.list": { major: 1, minor: 1 },
    "environment.status": { major: 1, minor: 1 },
    "environment.host.read": { major: 1, minor: 1 },
    "environment.host.bind": { major: 1, minor: 1 },
    "environment.move.stopPreview": { major: 1, minor: 0 },
    "environment.move.stop": { major: 1, minor: 0 },
  });
  mocks.state.status = environmentStatusFixture({
    principal: { kind: "personal" },
  });
  mocks.state.binding = {
    hostId: "host-a",
    environment: PERSONAL,
    explicit: false,
    enrolledByUserId: null,
    canUnbind: false,
  };
  useAuthStore.setState({
    status: "signed-in",
    profile: { userId: "user-me", userName: "Me", email: "me@example.com" },
    contextMetadata: { userId: "user-me", username: "me" },
    shareableTeams: [],
    subscriptionStatus: null,
  });
});

afterEach(() => {
  cleanup();
  resetTeamPageHarness();
  resetNegotiatedManifests();
  useAuthStore.setState({
    status: "signed-out",
    profile: null,
    contextMetadata: null,
    shareableTeams: [],
    subscriptionStatus: null,
  });
});

describe("HostEnvironmentSection", () => {
  it("the overview card offers Use this computer for a team on the computer the app runs on", async () => {
    const calls = giveCalls();
    const events: string[] = [];
    const ownershipReadback = Promise.withResolvers<HostOwnershipResult>();
    const readbackStarted = Promise.withResolvers<void>();
    const ownershipReads: { hostId: string; era: AuthEra }[] = [];
    mocks.auth.readHostOwnership.mockImplementation((hostId, era) => {
      ownershipReads.push({ hostId, era });
      if (ownershipReads.length === 1)
        return Promise.resolve(ownershipResult(PERSON_OWNER));
      if (ownershipReads.length === 2) {
        events.push("ownership-readback");
        readbackStarted.resolve();
        return ownershipReadback.promise;
      }
      return Promise.resolve(ownershipResult(TEAM_OWNER));
    });
    const queryClient = await openGiveDialog(calls, events);
    const acceptanceRequests = installGiveAcceptanceTransport(() => true, events);

    fireEvent.click(
      screen.getByRole("button", { name: "Confirm at this computer" }),
    );

    await readbackStarted.promise;
    const readbackKey = giveReadbackKey();
    expect(queryClient.getQueryData(readbackKey)).toBeUndefined();
    expect(screen.queryByText(/Mac mini now belongs to Acme/)).toBeNull();
    expect(events).toContain("plan");
    expect(events).toContain("stage");
    expect(events).toContain("start");
    expect(events).toContain("status:done");
    expect(events).toContain("ownership-readback");
    expect(events.indexOf("plan")).toBeLessThan(events.indexOf("stage"));
    expect(events.indexOf("stage")).toBeLessThan(events.indexOf("acceptance"));
    expect(events.indexOf("acceptance")).toBeLessThan(events.indexOf("start"));
    expect(events.indexOf("start")).toBeLessThan(events.indexOf("status:done"));
    expect(events.indexOf("status:done")).toBeLessThan(
      events.indexOf("ownership-readback"),
    );

    await act(async () => {
      ownershipReadback.resolve(ownershipResult(TEAM_OWNER));
    });

    await waitFor(() =>
      expect(queryClient.getQueryData(readbackKey)).toBe("confirmed"),
    );
    expect((await screen.findByRole("status")).textContent).toContain(
      "Mac mini now belongs to Acme.",
    );
    expect(calls.plans[0]).toEqual({
      target: {
        kind: "team",
        environmentId: TEAM.environmentId,
        teamId: GIVE_TEAM_ID,
      },
      personal: null,
    });
    expect(calls.stages).toEqual([
      {
        target: {
          kind: "team",
          environmentId: TEAM.environmentId,
          teamId: GIVE_TEAM_ID,
        },
        keyChoices: [],
        personal: null,
      },
    ]);
    expect(calls.starts).toEqual([
      {
        attemptId: GIVE_ATTEMPT_ID,
        planHash: GIVE_PLAN_HASH,
        acceptanceId: GIVE_ACCEPTANCE_ID,
      },
    ]);
    expect(
      acceptanceRequests.map(({ method, url, body }) => ({
        method,
        path: new URL(url).pathname,
        body,
      })),
    ).toEqual([
      {
        method: "POST",
        path: "/api/v3/hosts/host-a/move-acceptances",
        body: { ...GIVE_STAGE.evidence, disclosureHash: GIVE_DISCLOSURE_HASH },
      },
    ]);
    expect(ownershipReads[1]).toEqual({
      hostId: "host-a",
      era: { identity: "user-me", credentialGeneration: 1 },
    });
    expect(mocks.refreshDirectory).toHaveBeenCalledOnce();
  });

  it.each([
    ["still reports the person as owner", ownershipResult(PERSON_OWNER)],
    ["cannot confirm the owner", { kind: "network-error" }],
  ] as const)(
    "does not claim a completed transfer when ownership %s",
    async (_description, postMoveOwner) => {
      const calls = giveCalls();
      const events: string[] = [];
      const ownershipReads: { hostId: string; era: AuthEra }[] = [];
      mocks.auth.readHostOwnership.mockImplementation((hostId, era) => {
        ownershipReads.push({ hostId, era });
        return Promise.resolve(
          ownershipReads.length === 1
            ? ownershipResult(PERSON_OWNER)
            : postMoveOwner,
        );
      });
      const queryClient = await openGiveDialog(calls, events);
      const acceptanceRequests = installGiveAcceptanceTransport(() => true, events);

      fireEvent.click(
        screen.getByRole("button", { name: "Confirm at this computer" }),
      );

      await waitFor(() =>
        expect(queryClient.getQueryData(giveReadbackKey())).toBe(
          "not_confirmed",
        ),
      );
      expect((await screen.findByRole("alert")).textContent).toBe(
        "The team transfer could not be confirmed. Check this computer's Overview before trying again.",
      );
      expect(screen.queryByText(/now belongs to Acme/)).toBeNull();
      expect(events).toContain("plan");
      expect(events).toContain("stage");
      expect(events).toContain("start");
      expect(events).toContain("status:done");
      expect(events).toContain("ownership-readback");
      expect(calls.starts).toHaveLength(1);
      expect(acceptanceRequests).toHaveLength(1);
      expect(ownershipReads).toHaveLength(2);
      expect(mocks.refreshDirectory).not.toHaveBeenCalled();
    },
  );

  it("keeps the result quiet when sign-in ends during ownership readback", async () => {
    const calls = giveCalls();
    const events: string[] = [];
    const ownershipReadback = Promise.withResolvers<HostOwnershipResult>();
    const readbackStarted = Promise.withResolvers<void>();
    const origin = { current: true };
    const ownershipReads: { hostId: string; era: AuthEra }[] = [];
    mocks.auth.readHostOwnership.mockImplementation((hostId, era) => {
      ownershipReads.push({ hostId, era });
      if (ownershipReads.length === 1)
        return Promise.resolve(ownershipResult(PERSON_OWNER));
      events.push("ownership-readback");
      readbackStarted.resolve();
      return ownershipReadback.promise;
    });
    const queryClient = await openGiveDialog(calls, events);
    const acceptanceRequests = installGiveAcceptanceTransport(
      () => origin.current,
      events,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Confirm at this computer" }),
    );

    await readbackStarted.promise;
    const readbackKey = giveReadbackKey();
    origin.current = false;
    await act(async () => {
      ownershipReadback.resolve(ownershipResult(TEAM_OWNER));
    });

    await waitFor(() =>
      expect(queryClient.getQueryData(readbackKey)).toBe("sign_in_changed"),
    );
    expect(screen.queryByText(/now belongs to Acme/)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(calls.starts).toHaveLength(1);
    expect(acceptanceRequests).toHaveLength(1);
    expect(ownershipReads).toHaveLength(2);
    expect(mocks.refreshDirectory).not.toHaveBeenCalled();
  });

  it("shows the current personal source in the selector", () => {
    renderSection("personal", NO_SECTION_OPTIONS);

    const row = screen.getByTestId("host-settings-source");
    expect(row.textContent).toContain("Environment");
    const selector = screen.getByRole("combobox", { name: "Environment" });
    expect(within(selector).getByText("Personal")).toBeTruthy();
    expect(within(selector).getByText("Runs Personal").className).toContain(
      "in-data-[slot=select-trigger]:hidden",
    );
    expect(within(row).getByText("Details")).toBeTruthy();
    expect(screen.queryByText(/team's bots run/)).toBeNull();
    expect(screen.queryByText(/Machines in/)).toBeNull();
  });

  it("shows a legacy team source in the disabled selector", () => {
    mocks.state.binding = teamBinding(false);

    renderSection("personal", NO_SECTION_OPTIONS);

    const selector = screen.getByRole("combobox", { name: "Environment" });
    expect(selector.textContent).toBe("Acme");
    expect(selector.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Runs Acme")).toBeTruthy();
  });

  it("shows move progress instead of another source line while settings move", () => {
    mocks.state.status = environmentStatusFixture({
      principal: null,
      planes: { records: "local", broker: "local", room: "local" },
      setup: { stage: "moving_settings", state: "awaiting_consent" },
    });
    renderSection("personal", NO_SECTION_OPTIONS);
    expect(screen.getByText("Environment")).toBeTruthy();
    expect(
      screen.getByText("Runs its own settings, not in Personal yet"),
    ).toBeTruthy();
    const selector = screen.getByRole("combobox", { name: "Environment" });
    expect(within(selector).getByText("Mac mini")).toBeTruthy();
    expect(within(selector).queryByText("Local")).toBeNull();
    expect(
      within(selector).getByText("its own settings, not in Personal yet"),
    ).toBeTruthy();
  });

  it("shows nothing on a sandbox when no settings status or binding is available", () => {
    mocks.state.status = null;
    mocks.state.binding = null;
    renderSection("sandbox", NO_SECTION_OPTIONS);

    expect(screen.queryByTestId("host-settings-source")).toBeNull();
  });

  it("keeps a team-owned computer fixed to its actual registry owner", async () => {
    mocks.auth.readHostOwnership.mockResolvedValue(ownershipResult(TEAM_OWNER));
    renderSection("personal", {
      ...NO_SECTION_OPTIONS,
      owner: TEAM_OWNER,
      isLocalMachine: true,
    });

    expect(
      await screen.findByText("This computer belongs to Acme."),
    ).toBeTruthy();
    const selector = screen.getByRole("combobox", { name: "Environment" });
    expect(selector.textContent).toBe("Acme");
    expect(selector.hasAttribute("disabled")).toBe(true);
    expect(mocks.auth.readHostOwnership).toHaveBeenCalledWith("host-a", {
      identity: "user-me",
      credentialGeneration: 1,
    });
    expect(screen.queryByText("Use this computer for the team")).toBeNull();
  });

  it("does not offer team transfer when the host only negotiates bind 1.1", async () => {
    const bindCalls: string[] = [];
    const planCalls: string[] = [];
    recordNegotiatedHostManifest("host-a", {
      "environment.list": { major: 1, minor: 1 },
      "environment.status": { major: 1, minor: 1 },
      "environment.host.read": { major: 1, minor: 1 },
      "environment.host.bind": { major: 1, minor: 1 },
    });
    const queryClient = renderSection("personal", {
      ...NO_SECTION_OPTIONS,
      handlers: {
        "environment.host.bind": () => {
          bindCalls.push("bind");
          return teamBinding(true);
        },
        "environment.move.plan": () => {
          planCalls.push("plan");
          return GIVE_PLAN;
        },
      },
    });
    await waitFor(() =>
      expect(
        queryClient.getQueryState(
          authQueryKeys.hostOwnership(mocks.auth, "user-me", "host-a"),
        )?.status,
      ).toBe("success"),
    );

    fireEvent.keyDown(screen.getByRole("combobox", { name: "Environment" }), {
      key: "ArrowDown",
    });
    expect(
      await screen.findByRole("option", { name: /^Personal/ }),
    ).toBeTruthy();
    expect(screen.queryByRole("option", { name: /Acme/ })).toBeNull();
    expect(bindCalls).toEqual([]);
    expect(planCalls).toEqual([]);
  });

  it.each([
    ["a remote computer owned by the person", PERSON_OWNER, false],
    ["a computer with unknown ownership", undefined, true],
  ] as const)(
    "does not offer team transfer for %s",
    async (_description, owner, isLocalMachine) => {
      if (owner === undefined) {
        mocks.auth.readHostOwnership.mockResolvedValue({
          kind: "network-error",
        });
      }
      renderSection("personal", {
        ...NO_SECTION_OPTIONS,
        owner,
        isLocalMachine,
      });

      const selector = screen.getByRole("combobox", { name: "Environment" });
      fireEvent.keyDown(selector, { key: "ArrowDown" });
      expect(
        await screen.findByRole("option", { name: /^Personal/ }),
      ).toBeTruthy();
      expect(screen.queryByRole("option", { name: /Acme/ })).toBeNull();
      expect(mocks.auth.readHostOwnership).toHaveBeenCalledTimes(
        isLocalMachine ? 1 : 0,
      );
    },
  );

  it("claims a local team-owned computer through auth without an environment move", async () => {
    const runnerHost = dashboardRunnerHost();
    mocks.state.binding = teamBinding(true);
    mocks.auth.readHostOwnership
      .mockResolvedValueOnce(ownershipResult(TEAM_OWNER))
      .mockResolvedValue(ownershipResult(PERSON_OWNER));
    const claim = Promise.withResolvers<TeamComputerReleaseResult>();
    mocks.auth.releaseTeamComputer.mockReturnValue(claim.promise);
    const stopRequests: unknown[] = [];
    let stopPreviewCalls = 0;
    const countRequests: unknown[] = [];
    const queryClient = renderSection("personal", {
      owner: TEAM_OWNER,
      isLocalMachine: true,
      runnerHost,
      handlers: {
        "environment.move.stop": (request) => {
          stopRequests.push(request);
          return { outcome: "stopped" };
        },
        "environment.move.stopPreview": () => {
          stopPreviewCalls += 1;
          throw new Error("returning a team computer does not need a preview");
        },
        "environment.previewLocalFacts": (request) => {
          countRequests.push(request);
          return { activeTurns: 2, terminals: 0 };
        },
      },
    });

    fireEvent.click(
      await screen.findByRole("button", { name: "Claim this computer" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(
        "This computer will become yours. The team will lose access to it.",
      ),
    ).toBeTruthy();
    expect(
      await within(dialog).findByText("2 chats are running and will stop."),
    ).toBeTruthy();
    expect(countRequests).toEqual([
      { environmentId: TEAM.environmentId, subject: { kind: "computer" } },
    ]);
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Claim this computer" }),
    );

    const confirm = screen.getByRole("button", {
      name: "Claim this computer",
    });
    await waitFor(() => expect(confirm.hasAttribute("disabled")).toBe(true));
    expect(
      within(confirm).getByTestId("team-computer-claim-progress"),
    ).toBeTruthy();
    await act(async () => {
      claim.resolve({ kind: "ok" });
      await claim.promise;
    });
    await waitFor(() => {
      expect(noteHostMembershipChanged).toHaveBeenCalledWith("host-a");
    });
    expect(
      await screen.findByText(
        "This computer is now yours. The team can no longer run work on it.",
      ),
    ).toBeTruthy();

    await act(async () => {
      await queryClient.invalidateQueries({
        queryKey: authQueryKeys.hostOwnership(mocks.auth, "user-me", "host-a"),
      });
    });
    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: "Claim this computer" }),
      ).toBeNull();
    });
    expect(
      screen.queryByRole("button", { name: "Claim this computer" }),
    ).toBeNull();
    expect(mocks.auth.releaseTeamComputer).toHaveBeenCalledWith(
      "host-a",
      "env-team",
    );
    expect(stopRequests).toEqual([]);
    expect(stopPreviewCalls).toBe(0);
  });

  it("does not offer a Viewer Claim this computer on the local team computer", async () => {
    mocks.state.teamRole = "viewer";
    mocks.state.binding = teamBinding(true);
    mocks.auth.readHostOwnership.mockResolvedValue(ownershipResult(TEAM_OWNER));
    const queryClient = renderSection("personal", {
      ...NO_SECTION_OPTIONS,
      owner: TEAM_OWNER,
      isLocalMachine: true,
    });

    expect(
      await screen.findByText("This computer belongs to Acme."),
    ).toBeTruthy();
    await waitFor(() =>
      expect(
        queryClient.getQueryState(["environment-list-fixture", "viewer"])
          ?.status,
      ).toBe("success"),
    );
    expect(
      screen.queryByRole("button", { name: "Claim this computer" }),
    ).toBeNull();
  });

  it("hides Claim after the cached Admin role read fails", async () => {
    mocks.state.teamRole = "admin";
    mocks.state.binding = teamBinding(true);
    mocks.auth.readHostOwnership.mockResolvedValue(ownershipResult(TEAM_OWNER));
    const queryClient = renderSection("personal", {
      ...NO_SECTION_OPTIONS,
      owner: TEAM_OWNER,
      isLocalMachine: true,
    });
    const queryKey = ["environment-list-fixture", "admin"];

    expect(
      await screen.findByRole("button", { name: "Claim this computer" }),
    ).toBeTruthy();
    await waitFor(() =>
      expect(queryClient.getQueryState(queryKey)?.status).toBe("success"),
    );

    mocks.state.environmentListFails = true;
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey });
    });

    await waitFor(() =>
      expect(queryClient.getQueryState(queryKey)?.status).toBe("error"),
    );
    expect(
      screen.queryByRole("button", { name: "Claim this computer" }),
    ).toBeNull();
  });

  it("does not offer Claim this computer on a remote team-owned host", () => {
    mocks.state.binding = teamBinding(true);
    renderSection("personal", {
      ...NO_SECTION_OPTIONS,
      owner: TEAM_OWNER,
      isLocalMachine: false,
    });

    expect(
      screen.queryByRole("button", { name: "Claim this computer" }),
    ).toBeNull();
  });
});
