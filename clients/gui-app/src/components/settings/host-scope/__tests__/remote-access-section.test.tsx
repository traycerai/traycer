// The grant minter a write carries is read from the host binding. Mocked at
// that boundary, as the other Personal suites do; the client itself is a REAL
// `HostClient` over an in-memory messenger (`buildAccessHost`), so a switch
// travels the request path the app uses and only the host is faked.
const hostMock = vi.hoisted(
  (): { binding: { readonly auth: unknown } | null } => ({ binding: null }),
);
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostBinding: () => hostMock.binding,
  };
});
vi.mock("@/hooks/host/use-host-directory-entry", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/hooks/host/use-host-directory-entry")
    >();
  const { accessHostDirectoryEntryFor } =
    await import("@/components/settings/host-scope/__tests__/host-access-test-support");
  return {
    ...actual,
    useHostDirectoryEntry: accessHostDirectoryEntryFor,
  };
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VersionedRpcRegistry } from "@traycer/protocol/framework/index";
import type { VersionedStreamRpcRegistry } from "@traycer/protocol/framework/versioned-stream-rpc";
import type { IRemoteSession } from "@traycer-clients/shared/host-transport/remote/remote-session";
import {
  acquireRemoteSession,
  remoteSessionBorrowCountForTest,
  remoteSessionRefCountForTest,
  resetRemoteSessionReadinessListenersForTest,
  retireAllRemoteSessions,
  type RemoteSessionAcquirePolicy,
  type RemoteSessionIdentity,
} from "@traycer-clients/shared/host-transport/remote/active-remote-sessions";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { RemoteAccessState } from "@traycer/protocol/host/environment-schemas";
import {
  ACCESS_HOST_ID,
  ACCESS_HOST_NAME,
  ACCESS_METHODS,
  accessHostDirectoryEntryFor,
  buildAccessHost,
  fakeEnvironmentCloud,
  resetAccessHostDirectoryEntry,
  setAccessHostDirectoryEntry,
  type FakeEnvironmentCloud,
  type FakeEnvironmentCloudAnswer,
  type FakeEnvironmentCloudResponder,
  type AccessHost,
} from "@/components/settings/host-scope/__tests__/host-access-test-support";
import { REMOTE_ACCESS_TEXT } from "@/components/settings/host-scope/host-access-model";
import {
  type EnvironmentDescriptor,
  type EnvironmentDescriptorV11,
} from "@traycer/protocol/host/environment/contracts";
import type { EnvironmentDirectoryResult } from "@traycer-clients/shared/host-client/environment-directory";
import {
  HostRpcError,
  RetryableTransportError,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { useAuthStore } from "@/stores/auth/auth-store";
import { HostOverviewAccessTab } from "@/components/settings/panels/host-overview-access-tab";
import { environmentStatusFixture } from "@/lib/environment/__tests__/environment-test-support";
import { useHostAccessPromptsStore } from "@/stores/hosts/host-access-prompts-store";

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
  retireAllRemoteSessions();
  resetRemoteSessionReadinessListenersForTest();
  hostMock.binding = null;
  useAuthStore.getState().setSignedOut();
  window.localStorage.clear();
  useHostAccessPromptsStore.setState({
    remoteAccessAnswered: {},
    movedNoticeDismissed: {},
  });
});

beforeEach(() => {
  resetAccessHostDirectoryEntry();
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
  const entry = accessHostDirectoryEntryFor(ACCESS_HOST_ID);
  if (entry === null) throw new Error("The local test entry was not set");
  return renderTabWithDirectory(host, methods, promptAnswered, entry);
}

function renderTabWithDirectory(
  host: AccessHost,
  methods: readonly string[],
  promptAnswered: boolean,
  entry: HostDirectoryEntry,
): QueryClient {
  setAccessHostDirectoryEntry(entry);
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

function signInWithEnvironmentCloud(
  answer: FakeEnvironmentCloudAnswer | FakeEnvironmentCloudResponder,
): FakeEnvironmentCloud {
  const environmentCloud = fakeEnvironmentCloud(answer);
  useAuthStore.setState({
    status: "signed-in",
    contextMetadata: { userId: "remote-access-test", username: "remote" },
  });
  hostMock.binding = {
    auth: { environmentCloud: () => environmentCloud.cloud },
  };
  return environmentCloud;
}

const REMOTE_SESSION_IDENTITY: RemoteSessionIdentity = {
  hostId: ACCESS_HOST_ID,
  userId: "remote-access-test",
  hostPublicKey: "remote-host-key",
  relayAttachUrl: "wss://relay.test/attach",
  authRecovery: "revalidate",
  authEpoch: "remote-access-test-epoch",
  openAuth: "remote-access-test-bearer",
};

const REMOTE_SESSION_POLICY: RemoteSessionAcquirePolicy = {
  proactiveWakeEligible: true,
};

interface FakeRemoteSession extends IRemoteSession<
  VersionedRpcRegistry,
  VersionedStreamRpcRegistry
> {
  sendUnaryCalls: number;
  startCalls: number;
}

function fakeRemoteSession(
  ready: boolean,
  sendError: Error | null,
): FakeRemoteSession {
  const session: FakeRemoteSession = {
    sendUnaryCalls: 0,
    startCalls: 0,
    start: () => {
      session.startCalls += 1;
    },
    isClosed: () => false,
    isReady: () => ready,
    isSilentFor: () => false,
    sendUnary: ((method: string) => {
      session.sendUnaryCalls += 1;
      if (method !== "host.status.refresh")
        return Promise.reject(new Error(`not exercised: ${method}`));
      return sendError === null
        ? Promise.resolve({})
        : Promise.reject(sendError);
    }) as FakeRemoteSession["sendUnary"],
    forceReconnect: vi.fn(),
    subscribe: vi.fn(() => {
      throw new Error("not exercised by this test");
    }),
    subscribeAtVersion: vi.fn(() => {
      throw new Error("not exercised by this test");
    }),
    subscribeWithParamsProvider: vi.fn(() => {
      throw new Error("not exercised by this test");
    }),
    notifyBearerRotated: vi.fn(),
    notifyCloudVerdictChanged: vi.fn(),
    wake: vi.fn(),
    onClosed: () => () => undefined,
    subscribeAvailabilityRecovered: () => () => undefined,
    subscribeReadinessLost: () => () => undefined,
    getMethodSupport: () => "supported",
    getMethodSchemaVersion: () => ({ major: 1, minor: 0 }),
    subscribeMethodSupport: () => () => undefined,
    terminalFatal: () => null,
    close: vi.fn(),
  };
  return session;
}

function acquireFakeRemoteSession(session: FakeRemoteSession) {
  return acquireRemoteSession<VersionedRpcRegistry, VersionedStreamRpcRegistry>(
    REMOTE_SESSION_IDENTITY,
    REMOTE_SESSION_POLICY,
    () => session,
  );
}

const REMOTE_ENTRY: HostDirectoryEntry = {
  hostId: ACCESS_HOST_ID,
  label: "Remote computer",
  kind: "remote",
  websocketUrl: "wss://relay.test/attach",
  version: "1.5.0",
  transportDialability: "dialable",
};

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

  it("offers the team's switch to Admin and Editor, and withholds it from Viewer and unknown roles", async () => {
    const host = teamHost("off");
    const otherTeam: EnvironmentDescriptor = {
      environmentId: "another-team",
      ownerKind: "organization",
      ownerId: "another-owner",
      roomId: "another-room",
      label: "Other team",
    };
    const directory = {
      kind: "ok",
      list: {
        environments: [
          otherTeam,
          {
            environmentId: TEAM_ENVIRONMENT.environmentId,
            ownerKind: TEAM_ENVIRONMENT.ownerKind,
            ownerId: TEAM_ENVIRONMENT.ownerId,
            roomId: TEAM_ENVIRONMENT.roomId,
            label: TEAM_ENVIRONMENT.label,
          },
        ],
      },
    } satisfies EnvironmentDirectoryResult;
    const firstRoleRead = Promise.withResolvers<FakeEnvironmentCloudAnswer>();
    let heldRoleRead: Promise<FakeEnvironmentCloudAnswer> | null =
      firstRoleRead.promise;
    let failDirectoryRead = false;
    let directoryReads = 0;
    let targetRoleAnswer: FakeEnvironmentCloudAnswer = {
      status: 200,
      body: { viewer: { effectiveRole: "admin" } },
    };
    const authn = signInWithEnvironmentCloud((request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/hosts"))
        return { status: 200, body: { hosts: [{ purgePending: false }] } };
      if (path.endsWith("/environments/another-team/members"))
        return { status: 200, body: { viewer: { effectiveRole: "admin" } } };
      if (
        path.endsWith(`/environments/${TEAM_ENVIRONMENT.environmentId}/members`)
      )
        return heldRoleRead ?? targetRoleAnswer;
      throw new Error(`Unexpected environment read: ${request.method} ${path}`);
    });
    hostMock.binding = {
      auth: {
        environmentCloud: () => authn.cloud,
        listEnvironments: () => {
          directoryReads += 1;
          return Promise.resolve(
            failDirectoryRead ? { kind: "unavailable" } : directory,
          );
        },
      },
    };
    useAuthStore.setState({
      status: "signed-in",
      contextMetadata: { userId: "viewer-test", username: "viewer" },
      shareableTeams: [
        { teamId: "another-owner", slug: "other", avatarUrl: null },
        { teamId: TEAM_ENVIRONMENT.ownerId, slug: "studio", avatarUrl: null },
      ],
    });
    const queryClient = renderTab(host, ACCESS_METHODS, false);
    await shownState();
    const targetMemberReads = () =>
      authn.requests.filter((request) =>
        request.url.endsWith(
          `/api/v3/environments/${TEAM_ENVIRONMENT.environmentId}/members`,
        ),
      );
    await waitFor(() => expect(targetMemberReads().length).toBeGreaterThan(0));
    // The role read has started but is held, so it cannot authorize a switch.
    noSwitch();
    await act(async () => {
      heldRoleRead = null;
      firstRoleRead.resolve({
        status: 200,
        body: { viewer: { effectiveRole: "admin" } },
      });
      await queryClient.invalidateQueries({
        queryKey: ["host", "authn", "environment.list"],
      });
    });
    await screen.findByRole("button", { name: "Turn on" });

    for (const effectiveRole of ["admin", "editor"] as const) {
      targetRoleAnswer = {
        status: 200,
        body: { viewer: { effectiveRole } },
      };
      await rereadStatus(queryClient, host);
      const control = await screen.findByRole("button", { name: "Turn on" });
      expect(control.closest("[inert]")).toBeNull();
    }
    const refreshedRole = Promise.withResolvers<FakeEnvironmentCloudAnswer>();
    const beforeRefresh = targetMemberReads().length;
    heldRoleRead = refreshedRole.promise;
    const refreshing = queryClient.invalidateQueries({
      queryKey: ["host", "authn", "environment.list"],
    });
    await waitFor(() => {
      expect(targetMemberReads().length).toBeGreaterThan(beforeRefresh);
      noSwitch();
    });
    await act(async () => {
      heldRoleRead = null;
      refreshedRole.resolve({
        status: 200,
        body: { viewer: { effectiveRole: "admin" } },
      });
      await refreshing;
    });
    await screen.findByRole("button", { name: "Turn on" });

    targetRoleAnswer = {
      status: 200,
      body: { viewer: { effectiveRole: "viewer" } },
    };
    const beforeViewerRead = targetMemberReads().length;
    await rereadStatus(queryClient, host);
    expect(targetMemberReads().length).toBeGreaterThan(beforeViewerRead);
    noSwitch();

    targetRoleAnswer = { status: 500, body: {} };
    await rereadStatus(queryClient, host);
    noSwitch();

    failDirectoryRead = true;
    const beforeDirectoryRead = directoryReads;
    await rereadStatus(queryClient, host);
    expect(directoryReads).toBeGreaterThan(beforeDirectoryRead);
    noSwitch();
  });

  it("shows the permission refusal for authn's 403 and does not refresh the host", async () => {
    const host = hostWithRemoteAccess("off", "on");
    const { requests } = signInWithEnvironmentCloud({ status: 403, body: {} });
    renderTab(host, ACCESS_METHODS, true);

    fireEvent.click(await screen.findByRole("button", { name: "Turn on" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "You don't have permission to change remote access on this computer.",
    );
    expect(
      requests.map(({ method, url, body }) => [method, url, body]),
    ).toEqual([
      [
        "PUT",
        `https://authn.test/api/v3/hosts/${ACCESS_HOST_ID}/remote-access`,
        { enabled: true },
      ],
    ]);
    expect(host.paramsOf("host.status.refresh")).toEqual([]);
    expect(host.paramsOf("host.remoteAccess.set")).toEqual([]);
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
      expect(host.paramsOf("host.remoteAccess.set")).toEqual([{}]);
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

  it("keeps the permission line when the host refuses Off", async () => {
    const host = hostWithRemoteAccess("on", "off");
    host.state.remoteAccessError = HostRpcError.fromWireEnvelope(
      { code: "FORBIDDEN", message: "not allowed" },
      "remote-access-off",
      "host.remoteAccess.set",
    );
    renderTab(host, ACCESS_METHODS, true);

    fireEvent.click(await screen.findByRole("button", { name: "Turn off" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "You don't have permission to change remote access on this computer.",
    );
    expect(host.paramsOf("host.remoteAccess.set")).toEqual([{}]);
    expect(await shownState()).toBe(REMOTE_ACCESS_TEXT.on);
    expect(screen.getByRole("button", { name: "Turn off" })).toBeTruthy();
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
    const { requests } = signInWithEnvironmentCloud({
      status: 200,
      body: { remoteAccess: { enabled: true, epoch: 1 } },
    });
    const queryClient = renderTab(host, ACCESS_METHODS, false);
    expect(await shownState()).toBe(REMOTE_ACCESS_TEXT.off);

    fireEvent.click(await screen.findByRole("button", { name: "On" }));

    await waitFor(() => {
      expect(host.paramsOf("host.status.refresh")).toEqual([{}]);
    });
    expect(
      requests.map(({ method, url, body }) => [method, url, body]),
    ).toEqual([
      [
        "PUT",
        `https://authn.test/api/v3/hosts/${ACCESS_HOST_ID}/remote-access`,
        { enabled: true },
      ],
    ]);
    expect(host.paramsOf("host.remoteAccess.set")).toEqual([]);
    await waitFor(() => {
      expect(useHostAccessPromptsStore.getState().remoteAccessAnswered).toEqual(
        { [ACCESS_HOST_ID]: true },
      );
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      screen.queryByText("Couldn't change remote access. Try again."),
    ).toBeNull();
    host.state.status = environmentStatusFixture({ remoteAccess: "on" });
    await rereadStatus(queryClient, host);
    await waitFor(() => {
      expect(screen.getByTestId("remote-access-state").textContent).toBe(
        REMOTE_ACCESS_TEXT.on,
      );
    });
    expect(screen.getByRole("button", { name: "Turn off" })).toBeTruthy();
  });

  it("does not refresh or answer the question when the click's sign-in changes during authn's PUT", async () => {
    const host = hostWithRemoteAccess("off", "on");
    const put = Promise.withResolvers<FakeEnvironmentCloudAnswer>();
    const authn = signInWithEnvironmentCloud(() => put.promise);
    renderTab(host, ACCESS_METHODS, false);

    fireEvent.click(await screen.findByRole("button", { name: "On" }));
    await waitFor(() => expect(authn.requests).toHaveLength(1));

    authn.origin.current = false;
    put.resolve({
      status: 200,
      body: { remoteAccess: { enabled: true, epoch: 1 } },
    });

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "On" }).hasAttribute("disabled"),
      ).toBe(false);
    });
    expect(host.paramsOf("host.status.refresh")).toEqual([]);
    expect(host.paramsOf("host.remoteAccess.set")).toEqual([]);
    expect(useHostAccessPromptsStore.getState().remoteAccessAnswered).toEqual(
      {},
    );
    expect(screen.getByTestId("remote-access-question")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      screen.queryByText(
        "On. Other devices and agents signed in to your account can reach this computer.",
      ),
    ).toBeNull();
  });

  it("does not acquire or dial a remote session when none is ready to refresh", async () => {
    const host = hostWithRemoteAccess("off", "on");
    signInWithEnvironmentCloud({
      status: 200,
      body: { remoteAccess: { enabled: true, epoch: 1 } },
    });
    const session = fakeRemoteSession(false, null);
    const owner = acquireFakeRemoteSession(session);
    expect(remoteSessionRefCountForTest(REMOTE_SESSION_IDENTITY)).toBe(1);

    renderTabWithDirectory(host, ACCESS_METHODS, true, REMOTE_ENTRY);
    fireEvent.click(await screen.findByRole("button", { name: "Turn on" }));

    await waitFor(() => {
      expect(
        screen
          .getByRole("button", { name: "Turn on" })
          .hasAttribute("disabled"),
      ).toBe(false);
    });
    expect(host.paramsOf("host.status.refresh")).toEqual([]);
    expect(remoteSessionRefCountForTest(REMOTE_SESSION_IDENTITY)).toBe(1);
    expect(remoteSessionBorrowCountForTest(REMOTE_SESSION_IDENTITY)).toBe(0);
    expect(session.startCalls).toBe(0);
    expect(session.sendUnaryCalls).toBe(0);
    expect(screen.queryByRole("alert")).toBeNull();
    owner.close();
  });

  it("releases a ready remote session after its one refresh rejects", async () => {
    const host = hostWithRemoteAccess("off", "on");
    signInWithEnvironmentCloud({
      status: 200,
      body: { remoteAccess: { enabled: true, epoch: 1 } },
    });
    const refreshFailure = new RetryableTransportError({
      replaySafetyFromKey: false,
      code: "RPC_ERROR",
      message: "the open remote session dropped the refresh",
      requestId: "remote-refresh",
      method: "host.status.refresh",
      fatalDetails: null,
    });
    const session = fakeRemoteSession(true, refreshFailure);
    const owner = acquireFakeRemoteSession(session);

    renderTabWithDirectory(host, ACCESS_METHODS, true, REMOTE_ENTRY);
    fireEvent.click(await screen.findByRole("button", { name: "Turn on" }));

    await waitFor(() => {
      expect(
        screen
          .getByRole("button", { name: "Turn on" })
          .hasAttribute("disabled"),
      ).toBe(false);
    });
    expect(session.sendUnaryCalls).toBe(1);
    expect(remoteSessionBorrowCountForTest(REMOTE_SESSION_IDENTITY)).toBe(0);
    expect(remoteSessionRefCountForTest(REMOTE_SESSION_IDENTITY)).toBe(1);
    expect(host.paramsOf("host.status.refresh")).toEqual([]);
    expect(useHostAccessPromptsStore.getState().remoteAccessAnswered).toEqual({
      [ACCESS_HOST_ID]: true,
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      screen.queryByText("Couldn't change remote access. Try again."),
    ).toBeNull();
    owner.close();
  });

  it("shows the generic refusal for authn's 409 and does not refresh the host", async () => {
    const host = hostWithRemoteAccess("off", "on");
    const { requests } = signInWithEnvironmentCloud({ status: 409, body: {} });
    renderTab(host, ACCESS_METHODS, true);

    fireEvent.click(await screen.findByRole("button", { name: "Turn on" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Couldn't change remote access. Try again.",
    );
    expect(
      requests.map(({ method, url, body }) => [method, url, body]),
    ).toEqual([
      [
        "PUT",
        `https://authn.test/api/v3/hosts/${ACCESS_HOST_ID}/remote-access`,
        { enabled: true },
      ],
    ]);
    expect(host.paramsOf("host.status.refresh")).toEqual([]);
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
});
