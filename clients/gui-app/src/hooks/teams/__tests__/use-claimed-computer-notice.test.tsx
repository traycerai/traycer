import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthEra } from "@traycer-clients/shared/auth/request-context-provider";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import type {
  HostListItem,
  HostListResponse,
} from "@traycer/protocol/host/host-status";
import type { EnvironmentListResponseV11 } from "@traycer/protocol/host/environment/contracts";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/index";
import type { ClaimedComputersResult } from "@traycer-clients/shared/auth/claimed-computers";
import type { AuthService } from "@/lib/auth/auth-service";
import { authQueryKeys } from "@/lib/query-keys";
import { persistKey, STORE_KEYS } from "@/lib/persist";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  useClaimNoticesToldStore,
  useTeamComputersSeenStore,
  type SeenTeamComputer,
} from "@/stores/hosts/claimed-computer-notice-store";

const toasts = vi.hoisted(() => ({ info: vi.fn() }));
const bindingRef = vi.hoisted((): { value: unknown } => ({ value: null }));
const clientRef = vi.hoisted((): { value: unknown } => ({ value: null }));

vi.mock("sonner", () => ({ toast: { info: toasts.info } }));
vi.mock("@/lib/host", () => ({
  useHostBinding: () => bindingRef.value,
  useHostClient: () => clientRef.value,
}));

import { ClaimedComputerNotifier } from "@/providers/claimed-computer-notifier";

const USER_A = "user-a";
const USER_B = "user-b";
const TEAM_ID = "team-a";
const ENVIRONMENT_ID = "env-a";
const HOST_ID = "host-team-computer";
const TEAM_COMPUTER: SeenTeamComputer = { teamId: TEAM_ID, teamName: "Acme" };
const currentUser = { value: USER_A };

function teamHost(): HostListItem {
  return {
    hostId: HOST_ID,
    displayName: "Studio",
    platform: "darwin",
    kind: "personal",
    publicKey: "public-key",
    createdAt: "2026-01-01T00:00:00.000Z",
    status: {
      connectivity: "connectable",
      viewerReachability: "ok",
      clientCloud: "ok",
      updateState: "current",
      appVersion: "1.0.0",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
    },
    owner: { kind: "team", id: TEAM_ID, name: "Acme" },
    updatePolicy: "manual",
  };
}

function environmentList(): EnvironmentListResponseV11 {
  return {
    environments: [
      {
        environmentId: ENVIRONMENT_ID,
        ownerKind: "organization",
        ownerId: TEAM_ID,
        roomId: "room-a",
        label: "Acme",
        effectiveRole: "admin",
        kind: "team",
        hostCount: 1,
        providerHandle: "acme",
      },
    ],
  };
}

function claim(
  claimedAt = 1_763_164_800_000,
  claimantName: string | null = "Ada",
) {
  return {
    hostId: HOST_ID,
    computerName: "Studio",
    claimantName,
    claimedAt,
  };
}

function signIn(userId: string): void {
  currentUser.value = userId;
  useAuthStore.setState({
    status: "signed-in",
    profile: {
      userId,
      userName: userId,
      email: `${userId}@example.test`,
    },
    contextMetadata: { userId, username: userId },
    shareableTeams: [{ teamId: TEAM_ID, slug: "acme", avatarUrl: null }],
  });
}

function seedSeen(userId: string): void {
  useTeamComputersSeenStore.getState().setSeen(userId, {
    [HOST_ID]: TEAM_COMPUTER,
  });
}

function createFixture(
  initialHosts: HostListResponse,
  initialClaims: ClaimedComputersResult,
) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  let hosts = initialHosts;
  let environments = environmentList();
  const currentAuthEra = vi.fn((): AuthEra => ({
    identity: currentUser.value,
    credentialGeneration: 1,
  }));
  const fetchRegisteredHosts = vi.fn(
    async (_era: AuthEra): Promise<HostListResponse | null> => hosts,
  );
  const listEnvironments = vi.fn(() => environments);
  const listClaimedComputers = vi.fn(
    async (_environmentId: string): Promise<ClaimedComputersResult> =>
      initialClaims,
  );
  const auth = {
    currentAuthEra,
    fetchRegisteredHosts,
    listClaimedComputers,
  } satisfies Pick<
    AuthService,
    "currentAuthEra" | "fetchRegisteredHosts" | "listClaimedComputers"
  >;
  bindingRef.value = { auth };

  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => "claimed-computer-request",
    handlers: {
      "environment.list": () => listEnvironments(),
    },
  });
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => undefined },
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger,
  });
  spine.setRequestContext(
    createRequestContextFixture({
      origin: "renderer",
      bearerToken: "test-token",
    }),
  );
  clientRef.value = spine.createRequester(mockLocalHostEntry);

  const Wrapper = ({ children }: { readonly children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return {
    queryClient,
    listClaimedComputers,
    fetchRegisteredHosts,
    listEnvironments,
    setHosts(next: HostListResponse) {
      hosts = next;
    },
    setEnvironments(next: EnvironmentListResponseV11) {
      environments = next;
    },
    Wrapper,
  };
}

function resetStores(): void {
  useTeamComputersSeenStore.setState({ byViewer: {} });
  useClaimNoticesToldStore.setState({ seen: {} });
  localStorage.clear();
  toasts.info.mockReset();
}

beforeEach(() => {
  resetStores();
  useAuthStore.setState({
    status: "signed-out",
    profile: null,
    contextMetadata: null,
    shareableTeams: [],
    subscriptionStatus: null,
  });
  bindingRef.value = null;
  clientRef.value = null;
});

afterEach(() => {
  cleanup();
  resetStores();
  useAuthStore.setState({
    status: "signed-out",
    profile: null,
    contextMetadata: null,
    shareableTeams: [],
    subscriptionStatus: null,
  });
  bindingRef.value = null;
  clientRef.value = null;
});

describe("ClaimedComputerNotifier", () => {
  it("reads the team's claims on sign-in through the registered-host and environment queries", async () => {
    signIn(USER_A);
    const fixture = createFixture(
      { hosts: [teamHost()] },
      { kind: "ok", claims: [claim()] },
    );
    render(<ClaimedComputerNotifier />, { wrapper: fixture.Wrapper });

    await waitFor(() => {
      expect(fixture.fetchRegisteredHosts).toHaveBeenCalledTimes(1);
      expect(fixture.listClaimedComputers).toHaveBeenCalledWith(ENVIRONMENT_ID);
      expect(fixture.listEnvironments).toHaveBeenCalled();
    });
    expect(toasts.info).not.toHaveBeenCalled();
  });

  it("tells a teammate when a listed team computer leaves the host list", async () => {
    signIn(USER_A);
    const fixture = createFixture(
      { hosts: [teamHost()] },
      { kind: "ok", claims: [] },
    );
    const view = render(<ClaimedComputerNotifier />, {
      wrapper: fixture.Wrapper,
    });
    await waitFor(() =>
      expect(fixture.fetchRegisteredHosts).toHaveBeenCalledTimes(1),
    );
    await waitFor(() =>
      expect(
        useTeamComputersSeenStore.getState().byViewer[USER_A]?.[HOST_ID],
      ).toEqual(TEAM_COMPUTER),
    );
    fixture.listClaimedComputers.mockResolvedValue({
      kind: "ok",
      claims: [claim()],
    });
    fixture.setHosts({ hosts: [] });
    await act(async () => {
      await fixture.queryClient.invalidateQueries({
        queryKey: authQueryKeys.registeredHostsAll(),
      });
    });

    await waitFor(() => {
      expect(toasts.info).toHaveBeenCalledExactlyOnceWith(
        "Ada claimed this computer. It no longer belongs to Acme.",
        { id: `claimed-computer:${HOST_ID}@1763164800000` },
      );
    });
    await act(async () => {
      fixture.setHosts({ hosts: [teamHost()] });
      await fixture.queryClient.invalidateQueries({
        queryKey: authQueryKeys.registeredHostsAll(),
      });
    });
    await act(async () => {
      fixture.setHosts({ hosts: [] });
      await fixture.queryClient.invalidateQueries({
        queryKey: authQueryKeys.registeredHostsAll(),
      });
    });
    expect(toasts.info).toHaveBeenCalledExactlyOnceWith(
      "Ada claimed this computer. It no longer belongs to Acme.",
      { id: `claimed-computer:${HOST_ID}@1763164800000` },
    );
    view.unmount();
  });

  it.each([
    ["failed", { kind: "failed" }],
    ["unauthorized", { kind: "unauthorized" }],
    ["team not found", { kind: "not-found" }],
  ] as const)(
    "keeps a departure after a %s read so the next sign-in can tell it",
    async (_outcome, firstRead) => {
      signIn(USER_A);
      seedSeen(USER_A);
      const fixture = createFixture({ hosts: [] }, firstRead);
      const view = render(<ClaimedComputerNotifier />, {
        wrapper: fixture.Wrapper,
      });
      await waitFor(() =>
        expect(fixture.listClaimedComputers).toHaveBeenCalledWith(
          ENVIRONMENT_ID,
        ),
      );
      expect(toasts.info).not.toHaveBeenCalled();
      view.unmount();

      fixture.listClaimedComputers.mockResolvedValue({
        kind: "ok",
        claims: [claim()],
      });
      const resumed = render(<ClaimedComputerNotifier />, {
        wrapper: fixture.Wrapper,
      });
      await waitFor(() =>
        expect(toasts.info).toHaveBeenCalledExactlyOnceWith(
          "Ada claimed this computer. It no longer belongs to Acme.",
          { id: `claimed-computer:${HOST_ID}@1763164800000` },
        ),
      );
      resumed.unmount();
    },
  );

  it("does not tell a departure without a matching claim", async () => {
    signIn(USER_A);
    const fixture = createFixture(
      { hosts: [teamHost()] },
      { kind: "ok", claims: [] },
    );
    render(<ClaimedComputerNotifier />, { wrapper: fixture.Wrapper });
    await waitFor(() =>
      expect(
        useTeamComputersSeenStore.getState().byViewer[USER_A]?.[HOST_ID],
      ).toEqual(TEAM_COMPUTER),
    );

    fixture.setHosts({ hosts: [] });
    await act(async () => {
      await fixture.queryClient.invalidateQueries({
        queryKey: authQueryKeys.registeredHostsAll(),
      });
    });

    await waitFor(() =>
      expect(fixture.listClaimedComputers).toHaveBeenCalledWith(ENVIRONMENT_ID),
    );
    expect(toasts.info).not.toHaveBeenCalled();
  });

  it("tells a computer that departed while the app was closed from persisted seen data", async () => {
    signIn(USER_A);
    seedSeen(USER_A);
    const storageKey = persistKey(STORE_KEYS.teamComputersSeen);
    const saved = localStorage.getItem(storageKey);
    if (saved === null) throw new Error("seen computers were not persisted");
    useTeamComputersSeenStore.setState({ byViewer: {} });
    localStorage.setItem(storageKey, saved);
    await act(async () => {
      await useTeamComputersSeenStore.persist.rehydrate();
    });

    const fixture = createFixture(
      { hosts: [] },
      { kind: "ok", claims: [claim()] },
    );
    render(<ClaimedComputerNotifier />, { wrapper: fixture.Wrapper });

    await waitFor(() =>
      expect(toasts.info).toHaveBeenCalledExactlyOnceWith(
        "Ada claimed this computer. It no longer belongs to Acme.",
        { id: `claimed-computer:${HOST_ID}@1763164800000` },
      ),
    );
  });

  it("does not show a pending claim notice from the previous account", async () => {
    signIn(USER_A);
    seedSeen(USER_A);
    const fixture = createFixture({ hosts: [] }, { kind: "failed" });
    let resolveClaims: ((result: ClaimedComputersResult) => void) | undefined;
    fixture.listClaimedComputers.mockImplementation(() => {
      if (currentUser.value !== USER_A)
        return Promise.resolve({ kind: "ok", claims: [] });
      return new Promise((resolve) => {
        resolveClaims = resolve;
      });
    });
    const view = render(<ClaimedComputerNotifier />, {
      wrapper: fixture.Wrapper,
    });
    await waitFor(() => {
      expect(resolveClaims).toBeTypeOf("function");
    });

    act(() => signIn(USER_B));
    await waitFor(() => {
      expect(fixture.fetchRegisteredHosts).toHaveBeenCalledTimes(2);
    });
    await act(async () => {
      resolveClaims?.({ kind: "ok", claims: [claim()] });
    });

    expect(toasts.info).not.toHaveBeenCalled();
    view.unmount();
  });

  it("does not tell a claim without a claimant name", async () => {
    signIn(USER_A);
    seedSeen(USER_A);
    const fixture = createFixture(
      { hosts: [] },
      { kind: "ok", claims: [claim(1_763_164_800_000, null)] },
    );
    render(<ClaimedComputerNotifier />, { wrapper: fixture.Wrapper });

    await waitFor(() =>
      expect(fixture.listClaimedComputers).toHaveBeenCalledWith(ENVIRONMENT_ID),
    );
    expect(toasts.info).not.toHaveBeenCalled();
  });

  it("uses shared storage once per claim and tells a later claim of the same computer", async () => {
    signIn(USER_A);
    seedSeen(USER_A);
    const first = createFixture(
      { hosts: [] },
      { kind: "ok", claims: [claim()] },
    );
    const initial = render(<ClaimedComputerNotifier />, {
      wrapper: first.Wrapper,
    });
    await waitFor(() =>
      expect(toasts.info).toHaveBeenCalledExactlyOnceWith(
        "Ada claimed this computer. It no longer belongs to Acme.",
        { id: `claimed-computer:${HOST_ID}@1763164800000` },
      ),
    );
    initial.unmount();

    const storageKey = persistKey(STORE_KEYS.claimNoticesTold);
    const saved = localStorage.getItem(storageKey);
    if (saved === null) throw new Error("claim notice was not persisted");
    useClaimNoticesToldStore.setState({ seen: {} });
    localStorage.setItem(storageKey, saved);
    await act(async () => {
      await useClaimNoticesToldStore.persist.rehydrate();
    });
    seedSeen(USER_A);
    const remount = createFixture(
      { hosts: [] },
      { kind: "ok", claims: [claim()] },
    );
    const reopened = render(<ClaimedComputerNotifier />, {
      wrapper: remount.Wrapper,
    });
    await waitFor(() =>
      expect(remount.listClaimedComputers).toHaveBeenCalledWith(ENVIRONMENT_ID),
    );
    expect(toasts.info).toHaveBeenCalledTimes(1);
    reopened.unmount();

    seedSeen(USER_A);
    const later = createFixture(
      { hosts: [] },
      { kind: "ok", claims: [claim(1_763_164_800_001)] },
    );
    const laterNotice = render(<ClaimedComputerNotifier />, {
      wrapper: later.Wrapper,
    });
    await waitFor(() => expect(toasts.info).toHaveBeenCalledTimes(2));
    expect(toasts.info).toHaveBeenLastCalledWith(
      "Ada claimed this computer. It no longer belongs to Acme.",
      { id: `claimed-computer:${HOST_ID}@1763164800001` },
    );
    laterNotice.unmount();
  });

  it("does not tell a claim after the person has left the whole team", async () => {
    signIn(USER_A);
    useAuthStore.setState({ shareableTeams: [] });
    seedSeen(USER_A);
    const fixture = createFixture(
      { hosts: [] },
      { kind: "ok", claims: [claim()] },
    );
    render(<ClaimedComputerNotifier />, { wrapper: fixture.Wrapper });

    await waitFor(() =>
      expect(fixture.fetchRegisteredHosts).toHaveBeenCalledTimes(1),
    );
    expect(fixture.listClaimedComputers).not.toHaveBeenCalled();
    expect(toasts.info).not.toHaveBeenCalled();
  });

  it("keeps told claims separate for two viewers on one device", async () => {
    signIn(USER_A);
    seedSeen(USER_A);
    const first = createFixture(
      { hosts: [] },
      { kind: "ok", claims: [claim()] },
    );
    const viewA = render(<ClaimedComputerNotifier />, {
      wrapper: first.Wrapper,
    });
    await waitFor(() => expect(toasts.info).toHaveBeenCalledTimes(1));
    viewA.unmount();

    signIn(USER_B);
    seedSeen(USER_B);
    const second = createFixture(
      { hosts: [] },
      { kind: "ok", claims: [claim()] },
    );
    const viewB = render(<ClaimedComputerNotifier />, {
      wrapper: second.Wrapper,
    });
    await waitFor(() => expect(toasts.info).toHaveBeenCalledTimes(2));
    expect(toasts.info).toHaveBeenLastCalledWith(
      "Ada claimed this computer. It no longer belongs to Acme.",
      { id: `claimed-computer:${HOST_ID}@1763164800000` },
    );
    viewB.unmount();
  });
});
