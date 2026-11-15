import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type {
  HostListItem,
  HostOwnerPrincipal,
} from "@traycer/protocol/host/host-status";
import type { EnvironmentDescriptorV11 } from "@traycer/protocol/host/environment/contracts";
import type {
  ClaimedComputer,
  ClaimedComputersResult,
} from "@traycer-clients/shared/auth/claimed-computers";
import { useAuthStore } from "@/stores/auth/auth-store";
import { keyedSeen } from "@/lib/persist/keyed-seen-store";
import { authQueryKeys } from "@/lib/query-keys/auth-query-keys";

const mocks = vi.hoisted(() => {
  const read =
    vi.fn<
      (environmentId: string, signal: AbortSignal | null) => Promise<unknown>
    >();
  return {
    toastInfo: vi.fn(),
    auth: { current: { listClaimedComputers: read } },
    read,
    hosts: { current: { hosts: [] as unknown[] }, updatedAt: 1 },
    environments: { current: { environments: [] as unknown[] } },
  };
});

vi.mock("sonner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("sonner")>()),
  toast: {
    info: mocks.toastInfo,
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    message: vi.fn(),
    dismiss: vi.fn(),
  },
}));
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () => ({ auth: mocks.auth.current }),
}));
vi.mock("@/hooks/auth/use-registered-hosts-query", () => ({
  useRegisteredHosts: () => ({
    data: mocks.hosts.current,
    dataUpdatedAt: mocks.hosts.updatedAt,
  }),
}));
vi.mock("@/hooks/bots/use-environment-list-query", () => ({
  useEnvironmentListQuery: () => ({
    data: mocks.environments.current,
  }),
}));
vi.mock("@/hooks/host/use-host-lease", () => ({
  useHostLeases: () => [],
}));

import { useClaimedComputerNotice } from "@/hooks/teams/use-claimed-computer-notice";
import {
  useClaimNoticesToldStore,
  useOwnClaimsStore,
} from "@/stores/hosts/claimed-computer-notice-store";

const ADA_SENTENCE = "Ada claimed this computer. It no longer belongs to Acme.";
const BO_SENTENCE = "Bo claimed this computer. It no longer belongs to Acme.";

const CLAIM: ClaimedComputer = {
  hostId: "host-1",
  computerName: "Build Mac",
  claimantName: "Ada",
  claimedAt: "2026-11-14T10:00:00.000Z",
};

const LATER_CLAIM: ClaimedComputer = {
  hostId: "host-2",
  computerName: null,
  claimantName: "Bo",
  claimedAt: "2026-11-14T11:00:00.000Z",
};

function teamHost(hostId: string): HostListItem {
  const owner: HostOwnerPrincipal = {
    kind: "team",
    id: "team-a",
    name: "Acme",
  };
  return {
    hostId,
    displayName: hostId,
    platform: "linux",
    kind: "machine",
    publicKey: `pk-${hostId}`,
    createdAt: "2026-10-01T00:00:00.000Z",
    status: {
      connectivity: "connectable",
      viewerReachability: "unknown",
      clientCloud: "ok",
      updateState: "current",
      appVersion: "1.5.0",
      lastSeenAt: "2026-10-09T00:00:00.000Z",
    },
    updatePolicy: "manual",
    sandboxState: null,
    sandboxFrozen: false,
    profile: "agent",
    owner,
  };
}

const ACME: EnvironmentDescriptorV11 = {
  environmentId: "env-a",
  ownerKind: "organization",
  ownerId: "team-a",
  roomId: "room-a",
  label: "Acme",
  effectiveRole: "editor",
  kind: "team",
  hostCount: 1,
  providerHandle: null,
};

function signIn(userId: string): void {
  useAuthStore.setState({
    status: "signed-in",
    contextMetadata: { userId, username: userId },
  });
}

function answer(result: ClaimedComputersResult): Promise<unknown> {
  return Promise.resolve(result);
}

/** A read that answers nothing until its request is aborted. */
function heldUntilAborted(
  _environmentId: string,
  signal: AbortSignal | null,
): Promise<unknown> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => {
      reject(new Error("aborted"));
    });
  });
}

function newQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

function mount() {
  return mountWith(newQueryClient());
}

function mountWith(queryClient: QueryClient) {
  return renderHook(() => useClaimedComputerNotice(), {
    wrapper: (props: { readonly children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    ),
  });
}

/** user-a's entry for Acme, which a claimed computer's cover reads too. */
function claimedEntryKey(): readonly unknown[] {
  return authQueryKeys.claimedComputers(mocks.auth.current, "user-a", "env-a");
}

function toldFor(userId: string, claim: ClaimedComputer): boolean {
  return keyedSeen(
    useClaimNoticesToldStore.getState().seen,
    userId,
    `${claim.hostId}@${claim.claimedAt}`,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  useClaimNoticesToldStore.setState({ seen: {} });
  useOwnClaimsStore.setState({ byViewer: {} });
  mocks.auth.current = { listClaimedComputers: mocks.read };
  mocks.hosts.current = { hosts: [] };
  mocks.hosts.updatedAt = 1;
  mocks.environments.current = { environments: [ACME] };
  mocks.read.mockReset();
  mocks.toastInfo.mockReset();
  signIn("user-a");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useAuthStore.setState({ status: "signed-out", contextMetadata: null });
});

describe("useClaimedComputerNotice", () => {
  it("tells an untold claim on sign-in on a device that has seen no list, and not at the next sign-in", async () => {
    mocks.read.mockImplementation(() =>
      answer({ kind: "ok", claims: [CLAIM] }),
    );

    const view = mount();
    await waitFor(() =>
      expect(mocks.toastInfo).toHaveBeenCalledExactlyOnceWith(ADA_SENTENCE, {
        id: "claimed-computer:host-1@2026-11-14T10:00:00.000Z",
      }),
    );
    expect(mocks.read).toHaveBeenCalledWith("env-a", expect.any(AbortSignal));

    // The next sign-in reads again: a claim made since is told, and the one
    // already told is not.
    mocks.read.mockImplementation(() =>
      answer({ kind: "ok", claims: [LATER_CLAIM, CLAIM] }),
    );
    act(() => {
      useAuthStore.setState({ status: "signed-out", contextMetadata: null });
    });
    view.rerender();
    act(() => {
      signIn("user-a");
    });
    view.rerender();
    await waitFor(() =>
      expect(mocks.toastInfo).toHaveBeenLastCalledWith(BO_SENTENCE, {
        id: "claimed-computer:host-2@2026-11-14T11:00:00.000Z",
      }),
    );
    expect(mocks.toastInfo).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["failed", { kind: "failed" }],
    ["unauthorized", { kind: "unauthorized" }],
  ] as const)(
    "keeps an %s read waiting and tells the claim when the list refresh reads again",
    async (_kind, firstAnswer) => {
      mocks.read.mockImplementationOnce(() => answer(firstAnswer));
      const view = mount();
      await waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(1));
      expect(mocks.toastInfo).not.toHaveBeenCalled();

      mocks.read.mockImplementation(() =>
        answer({ kind: "ok", claims: [CLAIM] }),
      );
      mocks.hosts.updatedAt = 2;
      view.rerender();

      await waitFor(() =>
        expect(mocks.toastInfo).toHaveBeenCalledExactlyOnceWith(ADA_SENTENCE, {
          id: "claimed-computer:host-1@2026-11-14T10:00:00.000Z",
        }),
      );
    },
  );

  it("reads again when a team computer leaves the list", async () => {
    mocks.hosts.current = { hosts: [teamHost("host-1")] };
    mocks.read.mockImplementationOnce(() => answer({ kind: "ok", claims: [] }));
    const view = mount();
    await waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(1));

    mocks.read.mockImplementation(() =>
      answer({ kind: "ok", claims: [CLAIM] }),
    );
    mocks.hosts.current = { hosts: [] };
    mocks.hosts.updatedAt = 2;
    view.rerender();

    await waitFor(() =>
      expect(mocks.toastInfo).toHaveBeenCalledExactlyOnceWith(ADA_SENTENCE, {
        id: "claimed-computer:host-1@2026-11-14T10:00:00.000Z",
      }),
    );
    expect(mocks.read).toHaveBeenCalledTimes(2);
  });

  it("reads again when a team computer leaves the list while the sign-in read is still out", async () => {
    mocks.hosts.current = { hosts: [teamHost("host-1")] };
    let finishSignIn: (result: ClaimedComputersResult) => void = () =>
      undefined;
    mocks.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishSignIn = resolve;
        }),
    );
    let finishDeparture: (result: ClaimedComputersResult) => void = () =>
      undefined;
    mocks.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishDeparture = resolve;
        }),
    );
    const view = mount();
    await waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(1));

    // A teammate claims host-1 after the sign-in read took its snapshot.
    mocks.hosts.current = { hosts: [] };
    mocks.hosts.updatedAt = 2;
    view.rerender();

    // The departure's read starts once the sign-in read has answered.
    act(() => {
      finishSignIn({ kind: "ok", claims: [] });
    });
    await waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(2));
    act(() => {
      finishDeparture({ kind: "ok", claims: [CLAIM] });
    });
    await waitFor(() =>
      expect(mocks.toastInfo).toHaveBeenCalledExactlyOnceWith(ADA_SENTENCE, {
        id: "claimed-computer:host-1@2026-11-14T10:00:00.000Z",
      }),
    );
    expect(mocks.read).toHaveBeenCalledTimes(2);
  });

  it("leaves another reader's first read of the team to finish, and reads after it", async () => {
    let finishOther: (result: ClaimedComputersResult) => void = () => undefined;
    mocks.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOther = resolve;
        }),
    );
    mocks.read.mockImplementationOnce(() =>
      answer({ kind: "ok", claims: [CLAIM] }),
    );
    const queryClient = newQueryClient();
    // A claimed computer's cover reads the team's entry before any answer.
    const other = queryClient.fetchQuery({
      queryKey: claimedEntryKey(),
      queryFn: ({ signal }) => mocks.read("env-a", signal),
    });
    mountWith(queryClient);

    act(() => {
      finishOther({ kind: "ok", claims: [] });
    });
    await expect(other).resolves.toEqual({ kind: "ok", claims: [] });
    await waitFor(() =>
      expect(mocks.toastInfo).toHaveBeenCalledExactlyOnceWith(ADA_SENTENCE, {
        id: "claimed-computer:host-1@2026-11-14T10:00:00.000Z",
      }),
    );
    expect(mocks.read).toHaveBeenCalledTimes(2);
  });

  it("reads again when another reader cancels its first read of the team and reads it itself", async () => {
    mocks.read.mockImplementationOnce(heldUntilAborted);
    mocks.read.mockImplementation(() =>
      answer({ kind: "ok", claims: [CLAIM] }),
    );
    const queryClient = newQueryClient();
    mountWith(queryClient);
    await waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(1));

    // The cover cancels the read out before its state, then reads.
    await act(async () => {
      await queryClient.cancelQueries({
        queryKey: claimedEntryKey(),
        exact: true,
      });
      await queryClient.fetchQuery({
        queryKey: claimedEntryKey(),
        queryFn: ({ signal }) => mocks.read("env-a", signal),
        staleTime: 0,
      });
    });
    await waitFor(() =>
      expect(mocks.toastInfo).toHaveBeenCalledExactlyOnceWith(ADA_SENTENCE, {
        id: "claimed-computer:host-1@2026-11-14T10:00:00.000Z",
      }),
    );
  });

  it("reads again when another reader cancels a later read, which reverts to the earlier answer", async () => {
    mocks.hosts.current = { hosts: [teamHost("host-1")] };
    mocks.read.mockImplementationOnce(() => answer({ kind: "ok", claims: [] }));
    mocks.read.mockImplementationOnce(heldUntilAborted);
    mocks.read.mockImplementationOnce(() =>
      answer({ kind: "ok", claims: [CLAIM] }),
    );
    const queryClient = newQueryClient();
    const view = mountWith(queryClient);
    await waitFor(() =>
      expect(queryClient.getQueryData(claimedEntryKey())).toEqual({
        kind: "ok",
        claims: [],
      }),
    );

    mocks.hosts.current = { hosts: [] };
    mocks.hosts.updatedAt = 2;
    view.rerender();
    await waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(2));
    act(() => {
      void queryClient.cancelQueries({
        queryKey: claimedEntryKey(),
        exact: true,
      });
    });
    await waitFor(() =>
      expect(mocks.toastInfo).toHaveBeenCalledExactlyOnceWith(ADA_SENTENCE, {
        id: "claimed-computer:host-1@2026-11-14T10:00:00.000Z",
      }),
    );
    expect(mocks.read).toHaveBeenCalledTimes(3);
  });
  it("tells nothing, and records nothing, when the account switches while the read waits", async () => {
    let finish: (result: ClaimedComputersResult) => void = () => undefined;
    mocks.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    let finishB: (result: ClaimedComputersResult) => void = () => undefined;
    mocks.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishB = resolve;
        }),
    );
    const view = mount();
    await waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(1));

    act(() => {
      signIn("user-b");
    });
    view.rerender();
    await waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(2));
    // A's read answers after the switch, then B's own read answers.
    act(() => {
      finish({ kind: "ok", claims: [CLAIM] });
    });
    act(() => {
      finishB({ kind: "ok", claims: [LATER_CLAIM] });
    });

    await waitFor(() =>
      expect(mocks.toastInfo).toHaveBeenCalledExactlyOnceWith(BO_SENTENCE, {
        id: "claimed-computer:host-2@2026-11-14T11:00:00.000Z",
      }),
    );
    expect(toldFor("user-a", CLAIM)).toBe(false);
    expect(toldFor("user-b", CLAIM)).toBe(false);
  });

  it("tells the signed-in claimant about a claim from another computer", async () => {
    const ownClaim = { ...CLAIM, claimantName: "user-a" };
    mocks.read.mockImplementation(() =>
      answer({ kind: "ok", claims: [ownClaim] }),
    );

    mount();
    await waitFor(() =>
      expect(mocks.toastInfo).toHaveBeenCalledExactlyOnceWith(
        "user-a claimed this computer. It no longer belongs to Acme.",
        { id: `claimed-computer:${ownClaim.hostId}@${ownClaim.claimedAt}` },
      ),
    );
  });

  it.each([
    ["no matching claim", { kind: "ok", claims: [] }],
    ["a not-found answer", { kind: "not-found" }],
  ] as const)("does not tell a claim after %s", async (_case, result) => {
    mocks.read.mockImplementation(() => answer(result));

    mount();
    await waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(1));
    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.toastInfo).not.toHaveBeenCalled();
  });
});
