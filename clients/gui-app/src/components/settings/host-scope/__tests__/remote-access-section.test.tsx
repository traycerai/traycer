// The grant minter a write carries is read from the host binding. Mocked at
// that boundary, as the other Personal suites do; the client itself is a REAL
// `HostClient` over an in-memory messenger (`buildAccessHost`), so a switch
// travels the request path the app uses and only the host is faked.
const hostMock = vi.hoisted(
  (): { binding: { readonly auth: unknown } | null } => ({ binding: null }),
);
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return { ...actual, useHostBinding: () => hostMock.binding };
});

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { RemoteAccessState } from "@traycer/protocol/host/environment-schemas";
import {
  ACCESS_HOST_ID,
  ACCESS_HOST_NAME,
  ACCESS_METHODS,
  buildAccessHost,
  type AccessHost,
} from "@/components/settings/host-scope/__tests__/host-access-test-support";
import { REMOTE_ACCESS_TEXT } from "@/components/settings/host-scope/host-access-model";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  environmentListUpgradeV10ToV11,
  type EnvironmentDescriptorV11,
  type EnvironmentListResponseV11,
} from "@traycer/protocol/host/environment/contracts";
import { useAuthStore } from "@/stores/auth/auth-store";
import { HostOverviewAccessTab } from "@/components/settings/panels/host-overview-access-tab";
import { environmentStatusFixture } from "@/lib/environment/__tests__/environment-test-support";
import { useHostAccessPromptsStore } from "@/stores/hosts/host-access-prompts-store";

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
  hostMock.binding = null;
  useAuthStore.getState().setSignedOut();
  window.localStorage.clear();
  useHostAccessPromptsStore.setState({
    remoteAccessAnswered: {},
    movedNoticeDismissed: {},
  });
});

const WITHOUT_REMOTE_ACCESS_SET = ACCESS_METHODS.filter(
  (method) => method !== "host.remoteAccess.set",
);

const TEAM_ENVIRONMENT: EnvironmentDescriptorV11 = {
  environmentId: "environment-team",
  ownerKind: "organization",
  ownerId: "team-owner",
  roomId: "team-room",
  label: "Studio",
  effectiveRole: "editor",
  kind: "team",
  hostCount: 1,
  providerHandle: "studio",
};

function teamHost(remoteAccess: RemoteAccessState): AccessHost {
  return buildAccessHost({
    status: environmentStatusFixture({
      principal: { kind: "team", teamName: TEAM_ENVIRONMENT.label },
      remoteAccess,
    }),
    binding: {
      hostId: ACCESS_HOST_ID,
      environment: TEAM_ENVIRONMENT,
      explicit: true,
      enrolledByUserId: null,
      canUnbind: false,
    },
    environments: [TEAM_ENVIRONMENT],
  });
}

function hostWithRemoteAccess(
  remoteAccess: RemoteAccessState,
  answer: RemoteAccessState,
): AccessHost {
  return buildAccessHost({
    status: environmentStatusFixture({ remoteAccess }),
    remoteAccessAnswer: { state: answer },
  });
}

function renderTab(
  host: AccessHost,
  methods: readonly string[],
  promptAnswered: boolean,
): QueryClient {
  recordNegotiatedHostMethods(ACCESS_HOST_ID, methods);
  useHostAccessPromptsStore.setState({
    remoteAccessAnswered: promptAnswered ? { [ACCESS_HOST_ID]: true } : {},
    movedNoticeDismissed: {},
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <HostOverviewAccessTab
        client={host.client}
        hostId={ACCESS_HOST_ID}
        hostName={ACCESS_HOST_NAME}
        connecting={false}
        usable
      />
    </QueryClientProvider>,
  );
  return queryClient;
}

/** What the section says now, as the person reads it. */
async function shownState(): Promise<string> {
  const state = await screen.findByTestId("remote-access-state");
  return state.textContent;
}

/** The host answers a read again: the status poll, or the tab being reopened. */
async function rereadStatus(
  queryClient: QueryClient,
  host: AccessHost,
): Promise<void> {
  const before = host.reads.status;
  await act(async () => {
    await queryClient.invalidateQueries();
  });
  await waitFor(() => {
    expect(host.reads.status).toBeGreaterThan(before);
  });
}

function noSwitch(): void {
  expect(screen.queryByRole("button", { name: "Turn on" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Turn off" })).toBeNull();
}

describe("<RemoteAccessSection /> in Access and setup", () => {
  it("describes a team's remote access and keeps the computer's answered memory on return", async () => {
    const host = teamHost("on");
    const queryClient = renderTab(host, ACCESS_METHODS, true);
    expect(await shownState()).toBe(
      "On. Team members and agents can reach this computer.",
    );
    expect(screen.queryByTestId("remote-access-question")).toBeNull();

    host.state.status = { ...host.state.status, remoteAccess: "off" };
    await rereadStatus(queryClient, host);
    expect(await shownState()).toBe(
      "Off. Team members and agents can't reach this computer.",
    );
    host.state.status = environmentStatusFixture({ remoteAccess: "off" });
    await rereadStatus(queryClient, host);
    expect(await shownState()).toBe(REMOTE_ACCESS_TEXT.off);
    expect(screen.queryByTestId("remote-access-question")).toBeNull();
    expect(useHostAccessPromptsStore.getState().remoteAccessAnswered).toEqual({
      [ACCESS_HOST_ID]: true,
    });
  });

  it("offers the team's switch only to its admin or editor, fails closed on unknown roles, and shows a refused change", async () => {
    useAuthStore.setState({
      status: "signed-in",
      contextMetadata: { userId: "viewer-test", username: "viewer" },
    });
    const host = teamHost("off");
    const otherTeam = {
      ...TEAM_ENVIRONMENT,
      environmentId: "another-team",
      effectiveRole: "admin" as const,
    };
    host.state.environments = [otherTeam];
    const roleRead = Promise.withResolvers<EnvironmentListResponseV11>();
    host.state.environmentListRead = roleRead.promise;
    const queryClient = renderTab(host, ACCESS_METHODS, false);
    await shownState();
    await waitFor(() => expect(host.reads.environments).toBeGreaterThan(0));
    // The role read has started but is held, so it cannot authorize a switch.
    noSwitch();
    await act(async () => {
      host.state.environmentListRead = null;
      roleRead.resolve({ environments: host.state.environments });
      await roleRead.promise;
    });
    await rereadStatus(queryClient, host);
    noSwitch();

    for (const effectiveRole of ["admin", "editor"] as const) {
      host.state.environments = [
        otherTeam,
        { ...TEAM_ENVIRONMENT, effectiveRole },
      ];
      await rereadStatus(queryClient, host);
      const control = await screen.findByRole("button", { name: "Turn on" });
      expect(control.closest("[inert]")).toBeNull();
    }
    const refreshedRole = Promise.withResolvers<EnvironmentListResponseV11>();
    host.state.environmentListRead = refreshedRole.promise;
    const beforeRefresh = host.reads.environments;
    const refreshing = queryClient.invalidateQueries();
    await waitFor(() => {
      expect(host.reads.environments).toBeGreaterThan(beforeRefresh);
      noSwitch();
    });
    await act(async () => {
      host.state.environmentListRead = null;
      refreshedRole.resolve({ environments: host.state.environments });
      await refreshing;
    });
    await screen.findByRole("button", { name: "Turn on" });
    host.state.remoteAccessError = new HostRpcError({
      code: "FORBIDDEN",
      message: "private refusal detail",
      requestId: "refused-access",
      method: "host.remoteAccess.set",
      fatalDetails: null,
    });
    fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "You don't have permission to change remote access on this computer.",
    );
    expect(host.paramsOf("host.remoteAccess.set")).toEqual([{ enabled: true }]);
    expect(await shownState()).toBe(
      "Off. Team members and agents can't reach this computer.",
    );
    expect(useHostAccessPromptsStore.getState().remoteAccessAnswered).toEqual(
      {},
    );

    host.state.environments = environmentListUpgradeV10ToV11.upgradeResponse({
      environments: [TEAM_ENVIRONMENT],
    }).environments;
    await rereadStatus(queryClient, host);
    noSwitch();

    host.state.environments = [TEAM_ENVIRONMENT];
    await rereadStatus(queryClient, host);
    await screen.findByRole("button", { name: "Turn on" });
    host.state.failEnvironmentList = true;
    await rereadStatus(queryClient, host);
    noSwitch();
  });

  it("shows the unanswered prompt inside the Remote access group without a second row label", async () => {
    const host = hostWithRemoteAccess("off", "off");
    renderTab(host, ACCESS_METHODS, false);

    const section = await screen.findByTestId("remote-access-section");
    expect(
      within(section).getByRole("heading", { name: "Remote access" }),
    ).toBeTruthy();
    expect(
      within(section).getByTestId("remote-access-question").textContent,
    ).toBe(
      "Allow other devices and agents on your account to reach this computer?",
    );
    expect(within(section).queryByTestId("remote-access-state")).toBeNull();
    expect(within(section).getAllByRole("button", { name: "On" })).toHaveLength(
      1,
    );
    expect(
      within(section).getByRole("button", { name: "Not now" }),
    ).toBeTruthy();
  });

  it("Off shows 'turning off' until the host confirms", async () => {
    const host = hostWithRemoteAccess("on", "turning_off");
    const queryClient = renderTab(host, ACCESS_METHODS, true);
    expect(await shownState()).toBe(REMOTE_ACCESS_TEXT.on);

    fireEvent.click(await screen.findByRole("button", { name: "Turn off" }));

    // The request is Off, and nothing else.
    await waitFor(() => {
      expect(host.paramsOf("host.remoteAccess.set")).toEqual([
        { enabled: false },
      ]);
    });
    // The host answered `turning_off`, and its status read can still say `on`
    // for a poll or two: the section shows the host's answer, not that read.
    await waitFor(() => {
      expect(screen.getByTestId("remote-access-state").textContent).toBe(
        "Turning off. Other devices and agents are being disconnected.",
      );
    });
    expect(screen.getByTestId("remote-access-turning-off")).toBeTruthy();
    noSwitch();

    // The status is read again after the switch (the mutation re-reads it)
    // and again here: still `on`, still "turning off".
    await rereadStatus(queryClient, host);
    expect(host.state.status.remoteAccess).toBe("on");
    expect(screen.getByTestId("remote-access-state").textContent).toBe(
      REMOTE_ACCESS_TEXT.turning_off,
    );
    expect(screen.getByTestId("remote-access-turning-off")).toBeTruthy();
    noSwitch();

    // The host itself says `turning_off`: the same line, the same spinner.
    host.state.status = environmentStatusFixture({
      remoteAccess: "turning_off",
    });
    await rereadStatus(queryClient, host);
    expect(screen.getByTestId("remote-access-state").textContent).toBe(
      REMOTE_ACCESS_TEXT.turning_off,
    );
    expect(screen.getByTestId("remote-access-turning-off")).toBeTruthy();
    noSwitch();

    // Only the host's own `off` ends it.
    host.state.status = environmentStatusFixture({ remoteAccess: "off" });
    await rereadStatus(queryClient, host);
    await waitFor(() => {
      expect(screen.getByTestId("remote-access-state").textContent).toBe(
        "Off. Other devices and agents can't reach this computer. Your settings still reach it.",
      );
    });
    expect(screen.queryByTestId("remote-access-turning-off")).toBeNull();
    expect(screen.getByRole("button", { name: "Turn on" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Turn off" })).toBeNull();
  });

  it("says what On means and offers Turn off", async () => {
    renderTab(hostWithRemoteAccess("on", "turning_off"), ACCESS_METHODS, true);

    expect(await shownState()).toBe(
      "On. Other devices and agents signed in to your account can reach this computer.",
    );
    expect(screen.getByRole("button", { name: "Turn off" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Turn on" })).toBeNull();
    expect(screen.queryByTestId("remote-access-turning-off")).toBeNull();
  });

  it("Turn on sends enabled: true and shows what the host reads next", async () => {
    const host = hostWithRemoteAccess("off", "on");
    const queryClient = renderTab(host, ACCESS_METHODS, true);
    expect(await shownState()).toBe(REMOTE_ACCESS_TEXT.off);

    fireEvent.click(await screen.findByRole("button", { name: "Turn on" }));

    await waitFor(() => {
      expect(host.paramsOf("host.remoteAccess.set")).toEqual([
        { enabled: true },
      ]);
    });
    host.state.status = environmentStatusFixture({ remoteAccess: "on" });
    await rereadStatus(queryClient, host);
    await waitFor(() => {
      expect(screen.getByTestId("remote-access-state").textContent).toBe(
        REMOTE_ACCESS_TEXT.on,
      );
    });
    expect(screen.getByRole("button", { name: "Turn off" })).toBeTruthy();
  });

  it("shows a host that is turning remote access off by itself the same way", async () => {
    renderTab(hostWithRemoteAccess("turning_off", "off"), ACCESS_METHODS, true);

    expect(await shownState()).toBe(REMOTE_ACCESS_TEXT.turning_off);
    expect(screen.getByTestId("remote-access-turning-off")).toBeTruthy();
    noSwitch();
  });

  it("offers no switch on a host that does not have host.remoteAccess.set, and still says the state", async () => {
    const host = hostWithRemoteAccess("on", "turning_off");
    renderTab(host, WITHOUT_REMOTE_ACCESS_SET, true);

    expect(await shownState()).toBe(REMOTE_ACCESS_TEXT.on);
    noSwitch();
    expect(host.paramsOf("host.remoteAccess.set")).toEqual([]);
  });

  it("marks the host answered when the person switches remote access, and no other host", async () => {
    const host = hostWithRemoteAccess("on", "turning_off");
    renderTab(host, ACCESS_METHODS, false);
    await shownState();
    expect(useHostAccessPromptsStore.getState().remoteAccessAnswered).toEqual(
      {},
    );

    fireEvent.click(await screen.findByRole("button", { name: "Turn off" }));

    await waitFor(() => {
      expect(useHostAccessPromptsStore.getState().remoteAccessAnswered).toEqual(
        { [ACCESS_HOST_ID]: true },
      );
    });
    expect(
      useHostAccessPromptsStore.getState().remoteAccessAnswered["host-b"],
    ).toBeUndefined();
  });
});
