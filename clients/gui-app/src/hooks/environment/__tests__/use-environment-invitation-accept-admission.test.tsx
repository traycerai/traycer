import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { RequestContext } from "@traycer/protocol/auth/request-context";
import type { EnvironmentInvitationsAcceptResponse } from "@traycer/protocol/host/environment/contracts";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { LiveRevalidationOutcome } from "@/lib/auth/auth-service";
import { authQueryKeys, hostQueryKeys } from "@/lib/query-keys";
import {
  hostDoorStateFor,
  noteHostDoorState,
  useHostDoorStateStore,
} from "@/stores/host/host-door-state-store";
import { useEnvironmentInvitationAcceptMutation } from "../use-environment-invitations";

const otherHostId = "other-host";

function seedDoorStates(): void {
  noteHostDoorState({
    hostId: localHostId,
    kind: "not-a-member",
    detail: null,
  });
  noteHostDoorState({
    hostId: otherHostId,
    kind: "older-host",
    detail: null,
  });
}

function expectLocalDoorCleared(): void {
  expect(hostDoorStateFor(localHostId)).toBeNull();
  expect(hostDoorStateFor(otherHostId)?.kind).toBe("older-host");
}

function expectDoorStatesKept(): void {
  expect(hostDoorStateFor(localHostId)?.kind).toBe("not-a-member");
  expect(hostDoorStateFor(otherHostId)?.kind).toBe("older-host");
}

const localHostId = "local-team-computer";

const mocks = vi.hoisted(() => ({
  localHostId: null as string | null,
  currentContext: null as object | null,
  binding: null as {
    readonly auth: {
      getRequestContextProvider: () => { current: () => object | null };
      acceptEnvironmentInvitation: (
        environmentId: string,
      ) => Promise<EnvironmentInvitationsAcceptResponse>;
      revalidateCurrentContextAfterInvalidation: () => Promise<LiveRevalidationOutcome | null>;
    };
    readonly directory: {
      refresh: () => Promise<readonly HostDirectoryEntry[]>;
    };
  } | null,
  refreshHostFleet: vi.fn(() => Promise.resolve()),
  revalidate: vi.fn<() => Promise<LiveRevalidationOutcome | null>>(),
}));

vi.mock("@/lib/host", () => ({
  useHostBinding: () => mocks.binding,
}));

vi.mock("@/lib/host/local-host-id-snapshot", () => ({
  readLocalHostIdSnapshot: () => mocks.localHostId,
}));

vi.mock("@/hooks/chats/use-cloud-chat-queries", () => ({
  useCloudChatViewerId: () => "invitation-user",
}));

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({
    hostManagement: null,
    refreshHostFleet: mocks.refreshHostFleet,
  }),
}));

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {
    throw new Error("deferred promise was not initialized");
  };
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function installAuth(
  acceptEnvironmentInvitation: (
    environmentId: string,
  ) => Promise<EnvironmentInvitationsAcceptResponse>,
  context: RequestContext,
  directoryRefresh: () => Promise<readonly HostDirectoryEntry[]>,
): void {
  mocks.currentContext = context;
  const auth = {
    getRequestContextProvider: () => ({
      current: () => mocks.currentContext,
    }),
    acceptEnvironmentInvitation,
    revalidateCurrentContextAfterInvalidation: () => mocks.revalidate(),
  };
  mocks.binding = { auth, directory: { refresh: directoryRefresh } };
}

function createContext(userId: string): RequestContext {
  return createRequestContextFixture({
    origin: "renderer",
    bearerToken: `bearer-${userId}`,
    identity: {
      userId,
      username: userId,
      providerHandle: null,
    },
  });
}

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
}

const LIST_KEY = [
  ...hostQueryKeys.method("authn", "environment.list", {}),
  "invitation-user",
] as const;

/**
 * Seeds the account's environment list and records, into `order`, the moment
 * the hook invalidates it, so a case can say what came first.
 */
function watchListInvalidation(queryClient: QueryClient, order: string[]) {
  queryClient.setQueryData(LIST_KEY, { environments: [] });
  const invalidate = queryClient.invalidateQueries.bind(queryClient);
  return vi
    .spyOn(queryClient, "invalidateQueries")
    .mockImplementation((filters, options) => {
      const list = queryClient.getQueryCache().find({ queryKey: LIST_KEY });
      if (list !== undefined && filters?.predicate?.(list) === true)
        order.push("invalidate-list");
      return invalidate(filters, options);
    });
}

function listInvalidated(queryClient: QueryClient): boolean {
  return queryClient.getQueryState(LIST_KEY)?.isInvalidated === true;
}

function createWrapper(
  queryClient: QueryClient,
): (props: { readonly children: ReactNode }) => ReactNode {
  return ({ children }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe("invitation acceptance clears the local host door state", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = createQueryClient();
    useHostDoorStateStore.setState({ byHost: new Map() });
    mocks.localHostId = localHostId;
    mocks.currentContext = null;
    mocks.binding = null;
    mocks.refreshHostFleet.mockClear();
    mocks.revalidate.mockReset();
    mocks.revalidate.mockResolvedValue({ kind: "superseded" });
    seedDoorStates();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    queryClient.clear();
    useHostDoorStateStore.setState({ byHost: new Map() });
    mocks.binding = null;
    mocks.currentContext = null;
  });

  it("refreshes the host list after an accepted invitation, and reads the account before the environment list", async () => {
    const context = createContext("direct-user");
    const accept = vi.fn(() =>
      Promise.resolve({ outcome: "accepted" } as const),
    );
    const directoryRefresh = vi.fn(() => Promise.resolve([]));
    const order: string[] = [];
    const reread = deferred<LiveRevalidationOutcome>();
    mocks.revalidate.mockImplementation(() => {
      order.push("revalidate");
      return reread.promise;
    });
    installAuth(accept, context, directoryRefresh);
    const invalidateQueries = watchListInvalidation(queryClient, order);
    const { result } = renderHook(
      () => useEnvironmentInvitationAcceptMutation(),
      { wrapper: createWrapper(queryClient) },
    );

    const mutation: { value: Promise<unknown> | null } = { value: null };
    await act(async () => {
      mutation.value = result.current.mutateAsync({ environmentId: "team-1" });
      await vi.waitFor(() => expect(order).toEqual(["revalidate"]));
    });
    // The account read is held: a list invalidation made alongside it, and not
    // after its answer, would already be in `order` and invalidated.
    expect(listInvalidated(queryClient)).toBe(false);

    await act(async () => {
      reread.resolve({ kind: "superseded" });
      if (mutation.value === null)
        throw new Error("expected an invitation mutation");
      await mutation.value;
    });

    expect(accept).toHaveBeenCalledWith("team-1");
    expectLocalDoorCleared();
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: authQueryKeys.registeredHostsAll(),
    });
    expect(directoryRefresh).toHaveBeenCalledOnce();
    expect(mocks.refreshHostFleet).toHaveBeenCalledOnce();
    // The list joins each row to the account's teams, so it is invalidated
    // only after the account read has answered.
    expect(order).toEqual(["revalidate", "invalidate-list"]);
    expect(listInvalidated(queryClient)).toBe(true);
  });

  it.each([
    ["rejects", () => Promise.reject(new Error("authn is down"))],
    ["answers network-error", () => Promise.resolve({ kind: "network-error" })],
  ] satisfies [string, () => Promise<LiveRevalidationOutcome>][])(
    "still invalidates the environment list when the account read %s",
    async (_name, answer) => {
      const order: string[] = [];
      mocks.revalidate.mockImplementation(() => {
        order.push("revalidate");
        return answer();
      });
      installAuth(
        () => Promise.resolve({ outcome: "accepted" }),
        createContext("direct-user"),
        () => Promise.resolve([]),
      );
      watchListInvalidation(queryClient, order);
      const { result } = renderHook(
        () => useEnvironmentInvitationAcceptMutation(),
        { wrapper: createWrapper(queryClient) },
      );

      await act(async () => {
        await result.current.mutateAsync({ environmentId: "team-1" });
      });

      expect(order).toEqual(["revalidate", "invalidate-list"]);
      expect(listInvalidated(queryClient)).toBe(true);
      // The accept is never lost to the account read's failure.
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
    },
  );

  it("does not invalidate after an invitation was not found", async () => {
    const context = createContext("direct-user");
    const directoryRefresh = vi.fn(() => Promise.resolve([]));
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    installAuth(
      () => Promise.resolve({ outcome: "not_found" }),
      context,
      directoryRefresh,
    );
    const { result } = renderHook(
      () => useEnvironmentInvitationAcceptMutation(),
      { wrapper: createWrapper(queryClient) },
    );

    await act(async () => {
      await result.current.mutateAsync({ environmentId: "team-1" });
    });

    expectDoorStatesKept();
    expect(invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: authQueryKeys.registeredHostsAll(),
    });
    expect(directoryRefresh).not.toHaveBeenCalled();
    expect(mocks.refreshHostFleet).not.toHaveBeenCalled();
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });

  it("does not invalidate on failure or when the account context changes before success", async () => {
    const failureContext = createContext("failure-user");
    const rejectAccept = vi.fn(() =>
      Promise.reject(new Error("request failed")),
    );
    const failedDirectoryRefresh = vi.fn(() => Promise.resolve([]));
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    installAuth(rejectAccept, failureContext, failedDirectoryRefresh);
    const failed = renderHook(() => useEnvironmentInvitationAcceptMutation(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await expect(
        failed.result.current.mutateAsync({ environmentId: "team-1" }),
      ).rejects.toThrow("request failed");
    });
    expectDoorStatesKept();
    expect(invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: authQueryKeys.registeredHostsAll(),
    });
    expect(failedDirectoryRefresh).not.toHaveBeenCalled();
    expect(mocks.refreshHostFleet).not.toHaveBeenCalled();
    failed.unmount();

    const accountChangeContext = createContext("before-switch");
    const pending = deferred<EnvironmentInvitationsAcceptResponse>();
    const acceptStarted = deferred<void>();
    const switchedDirectoryRefresh = vi.fn(() => Promise.resolve([]));
    invalidateQueries.mockClear();
    mocks.refreshHostFleet.mockClear();
    installAuth(
      () => {
        acceptStarted.resolve();
        return pending.promise;
      },
      accountChangeContext,
      switchedDirectoryRefresh,
    );
    const switched = renderHook(
      () => useEnvironmentInvitationAcceptMutation(),
      { wrapper: createWrapper(queryClient) },
    );
    const mutation: {
      value: Promise<EnvironmentInvitationsAcceptResponse> | null;
    } = { value: null };
    await act(async () => {
      mutation.value = switched.result.current.mutateAsync({
        environmentId: "team-1",
      });
      await acceptStarted.promise;
    });
    mocks.currentContext = createContext("after-switch");
    await act(async () => {
      pending.resolve({ outcome: "accepted" });
      if (mutation.value === null)
        throw new Error("expected an invitation mutation");
      await mutation.value;
    });

    expectDoorStatesKept();
    expect(invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: authQueryKeys.registeredHostsAll(),
    });
    expect(switchedDirectoryRefresh).not.toHaveBeenCalled();
    expect(mocks.refreshHostFleet).not.toHaveBeenCalled();
    // Neither the failed accept nor the one answered after the switch read the
    // account: the new account is told nothing.
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });
});
