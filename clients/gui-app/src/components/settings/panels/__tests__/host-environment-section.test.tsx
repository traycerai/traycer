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
import type { EnvironmentStatusResponseV11 } from "@traycer/protocol/host/environment-schemas";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";

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
  ownerId: "team-1",
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
  },
  refreshDirectory: vi.fn<() => Promise<unknown>>(),
}));
const invalidateLocalTeamAdmissionAfterClaim = vi.hoisted(() =>
  vi.fn<(hostId: string, runnerHost: IRunnerHost) => Promise<void>>(),
);

vi.mock("@/lib/host/app-local-open-auth", () => ({
  invalidateLocalTeamAdmissionAfterClaim,
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

vi.mock("@/hooks/bots/use-environment-host-read-query", () => ({
  useEnvironmentHostReadQuery: () => ({
    kind: "binding",
    query: { isError: false, data: mocks.state.binding ?? undefined },
  }),
}));
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
  id: "team-1",
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
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
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
                      teamOwned: false,
                    }
                  : null,
            }),
            client: makeClient(handlers),
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

beforeEach(() => {
  mocks.auth.currentAuthEra.mockReset();
  mocks.auth.currentAuthEra.mockReturnValue({
    identity: "user-me",
    credentialGeneration: 1,
  });
  mocks.auth.readHostOwnership.mockReset();
  mocks.auth.readHostOwnership.mockResolvedValue(ownershipResult(PERSON_OWNER));
  mocks.auth.releaseTeamComputer.mockReset();
  mocks.auth.releaseTeamComputer.mockResolvedValue({ kind: "ok" });
  invalidateLocalTeamAdmissionAfterClaim.mockReset();
  invalidateLocalTeamAdmissionAfterClaim.mockResolvedValue(undefined);
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
    const events: string[] = [];
    const ownershipResults = [
      ownershipResult(PERSON_OWNER),
      ownershipResult(TEAM_OWNER),
    ];
    mocks.auth.readHostOwnership.mockImplementation(() => {
      events.push("ownership-read");
      return Promise.resolve(
        ownershipResults.shift() ?? ownershipResult(TEAM_OWNER),
      );
    });
    const movePlanCalls: string[] = [];
    const queryClient = renderSection("personal", {
      owner: PERSON_OWNER,
      isLocalMachine: true,
      handlers: {
        "environment.host.bind": ({ environmentId }) => {
          events.push(`bind:${environmentId}`);
          return teamBinding(true);
        },
        "environment.move.plan": () => {
          movePlanCalls.push("called");
          throw new Error("team binding must not plan a Personal move");
        },
      },
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
    for (const disclosure of TEAM_TRANSFER_DISCLOSURE) {
      expect(within(dialog).getByText(disclosure)).toBeTruthy();
    }
    expect(
      within(dialog).getByText(
        "Any member of the team can claim this computer as their own.",
      ),
    ).toBeTruthy();
    expect(
      within(dialog).getByText(
        "The team will own this computer. Any member of the team can claim it as their own.",
      ),
    ).toBeTruthy();
    expect(within(dialog).queryByText("Personal")).toBeNull();
    expect(
      within(dialog).getByRole("button", { name: "Confirm at this computer" }),
    ).toBeTruthy();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Confirm at this computer" }),
    );

    expect((await screen.findByRole("status")).textContent).toContain(
      "Mac mini now belongs to Acme.",
    );
    expect(events.slice(0, 3)).toEqual([
      "ownership-read",
      "bind:env-team",
      "ownership-read",
    ]);
    expect(movePlanCalls).toEqual([]);
  });

  it.each([
    ["still reports the person as owner", ownershipResult(PERSON_OWNER)],
    ["cannot confirm the owner", { kind: "network-error" }],
  ] as const)(
    "does not claim a completed transfer when ownership %s",
    async (_description, postBindOwner) => {
      const ownershipResults: HostOwnershipResult[] = [
        ownershipResult(PERSON_OWNER),
        postBindOwner,
      ];
      mocks.auth.readHostOwnership.mockImplementation(() =>
        Promise.resolve(ownershipResults.shift() ?? postBindOwner),
      );
      const queryClient = renderSection("personal", {
        owner: PERSON_OWNER,
        isLocalMachine: true,
        handlers: {
          "environment.host.bind": () => teamBinding(true),
        },
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
      fireEvent.click(
        within(dialog).getByRole("button", {
          name: "Confirm at this computer",
        }),
      );

      expect((await screen.findByRole("alert")).textContent).toContain(
        "The team transfer could not be confirmed.",
      );
      expect(screen.queryByText(/now belongs to Acme/)).toBeNull();
    },
  );

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

  it("does not offer team transfer when the host only negotiates bind 1.0", async () => {
    recordNegotiatedHostManifest("host-a", {
      "environment.list": { major: 1, minor: 1 },
      "environment.status": { major: 1, minor: 1 },
      "environment.host.read": { major: 1, minor: 1 },
      "environment.host.bind": { major: 1, minor: 0 },
    });
    const queryClient = renderSection("personal", NO_SECTION_OPTIONS);
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
    const admissionCheck = Promise.withResolvers<void>();
    mocks.auth.releaseTeamComputer.mockReturnValue(claim.promise);
    invalidateLocalTeamAdmissionAfterClaim.mockReturnValue(
      admissionCheck.promise,
    );
    const stopRequests: unknown[] = [];
    let stopPreviewCalls = 0;
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
      expect(invalidateLocalTeamAdmissionAfterClaim).toHaveBeenCalledWith(
        "host-a",
        runnerHost,
      );
    });

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
      screen.queryByText(
        "This computer is now yours. The team can no longer run work on it.",
      ),
    ).toBeNull();

    await act(async () => {
      admissionCheck.resolve();
      await admissionCheck.promise;
    });

    expect(
      await screen.findByText(
        "This computer is now yours. The team can no longer run work on it.",
      ),
    ).toBeTruthy();
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
