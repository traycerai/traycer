/** The Overview's settings source row, including the legacy team state. */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
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
  EnvironmentHostBinding,
} from "@traycer/protocol/host/environment/contracts";
import { TEAM_TRANSFER_DISCLOSURE } from "@traycer/protocol/host/environment/team-transfer-disclosure";
import type {
  HostListItem,
  HostOwnerPrincipal,
} from "@traycer/protocol/host/host-status";
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

const mocks = vi.hoisted(() => ({
  state: {
    binding: null as EnvironmentHostBinding | null,
    status: null as EnvironmentStatusResponseV11 | null,
    environmentListCalls: 0,
  },
}));

vi.mock("@/hooks/bots/use-environment-list-query", () => ({
  useEnvironmentListQuery: () => {
    mocks.state.environmentListCalls += 1;
    return { data: { environments: [PERSONAL, TEAM] } };
  },
}));

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: (_hostId: string | null, method: string) =>
    method === "environment.host.read",
}));
vi.mock("@/hooks/bots/use-environment-host-read-query", () => ({
  useEnvironmentHostReadQuery: () => ({
    isError: false,
    data: mocks.state.binding ?? undefined,
  }),
}));
vi.mock("@/hooks/environment/use-environment-reads", () => ({
  useEnvironmentStatusRead: () => ({ data: mocks.state.status }),
}));
vi.mock("@/hooks/host/use-host-negotiated-method-version", () => ({
  useHostNegotiatedMethodVersions: (hostIds: readonly string[]) =>
    new Map(hostIds.map((hostId) => [hostId, { major: 1, minor: 1 }])),
}));
import { HostEnvironmentSection } from "@/components/settings/panels/host-environment-section";

function makeClient(
  handlers: MockHandlerMap<HostRpcRegistry> | undefined,
): HostClient<HostRpcRegistry> {
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => undefined },
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: handlers ?? {},
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  return spine.createRequester(mockLocalHostEntry);
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
  },
): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <HostEnvironmentSection
        hostName="Mac mini"
        scope={hostScopeFixture({
          host: hostScopeOptionFixture({
            hostId: "host-a",
            name: "Mac mini",
            kind,
            isLocalMachine: options.isLocalMachine ?? false,
            item:
              options.owner === undefined ? null : registryItem(options.owner),
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
          client: makeClient(options.handlers),
        })}
      />
    </QueryClientProvider>,
  );
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

beforeEach(() => {
  mocks.state.environmentListCalls = 0;
  recordNegotiatedHostManifest("host-a", {
    "environment.host.bind": { major: 1, minor: 0 },
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
});

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
});

describe("HostEnvironmentSection", () => {
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

  it("offers a team to the local person's computer and confirms its team binding", async () => {
    const bindCalls: string[] = [];
    const movePlanCalls: string[] = [];
    renderSection("personal", {
      owner: PERSON_OWNER,
      isLocalMachine: true,
      handlers: {
        "environment.host.bind": ({ environmentId }) => {
          bindCalls.push(environmentId);
          return teamBinding(true);
        },
        "environment.move.plan": () => {
          movePlanCalls.push("called");
          throw new Error("team binding must not plan a Personal move");
        },
      },
    });

    const selector = screen.getByRole("combobox", { name: "Environment" });
    fireEvent.keyDown(selector, { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: /Acme/ }));

    const dialog = await screen.findByRole("dialog");
    for (const disclosure of TEAM_TRANSFER_DISCLOSURE) {
      expect(within(dialog).getByText(disclosure)).toBeTruthy();
    }
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
    expect(bindCalls).toEqual(["env-team"]);
    expect(movePlanCalls).toEqual([]);
  });

  it("keeps a team-owned computer fixed to its actual registry owner", () => {
    renderSection("personal", {
      ...NO_SECTION_OPTIONS,
      owner: TEAM_OWNER,
      isLocalMachine: true,
    });

    const selector = screen.getByRole("combobox", { name: "Environment" });
    expect(selector.textContent).toBe("Acme");
    expect(selector.hasAttribute("disabled")).toBe(true);
    expect(mocks.state.environmentListCalls).toBe(0);
    expect(screen.queryByText("Use this computer for the team")).toBeNull();
  });

  it.each([
    ["a remote computer owned by the person", PERSON_OWNER, false],
    ["a computer with unknown ownership", undefined, true],
  ] as const)(
    "does not offer team transfer for %s",
    async (_description, owner, isLocalMachine) => {
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
      expect(mocks.state.environmentListCalls).toBe(0);
    },
  );

  it("returns a local team-owned computer with no choices or team credential in the client result", async () => {
    mocks.state.binding = teamBinding(true);
    const stopRequests: unknown[] = [];
    const serializedResponses: string[] = [];
    let stopPreviewCalls = 0;
    renderSection("personal", {
      owner: TEAM_OWNER,
      isLocalMachine: true,
      handlers: {
        "environment.move.stop": (request) => {
          stopRequests.push(request);
          const response = { outcome: "stopped" as const };
          serializedResponses.push(JSON.stringify(response));
          return response;
        },
        "environment.move.stopPreview": () => {
          stopPreviewCalls += 1;
          throw new Error("returning a team computer does not need a preview");
        },
      },
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Return this computer" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/team will lose access/)).toBeTruthy();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Return computer" }),
    );

    expect((await screen.findByRole("status")).textContent).toContain(
      "This computer was returned.",
    );
    expect(stopRequests).toEqual([{ choices: [] }]);
    expect(stopPreviewCalls).toBe(0);
    expect(serializedResponses).toEqual(['{"outcome":"stopped"}']);
    expect(serializedResponses[0]).not.toMatch(/credential|token|secret/i);
  });

  it("does not offer Return this computer on a remote team-owned host", () => {
    mocks.state.binding = teamBinding(true);
    renderSection("personal", {
      ...NO_SECTION_OPTIONS,
      owner: TEAM_OWNER,
      isLocalMachine: false,
    });

    expect(
      screen.queryByRole("button", { name: "Return this computer" }),
    ).toBeNull();
  });
});
