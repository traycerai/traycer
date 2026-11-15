import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { RequestContext } from "@traycer/protocol/auth/request-context";
import type { ChosenSignIn } from "@/lib/auth/auth-service";
import type { EnvironmentInvitationsAcceptResponse } from "@traycer/protocol/host/environment/contracts";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { authQueryKeys } from "@/lib/query-keys";
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
  currentUserId: null as string | null,
  identityGeneration: 0,
  switchAfterContextRead: null as {
    readonly context: object;
    readonly userId: string;
    readonly identityGeneration: number;
  } | null,
  binding: null as {
    readonly auth: {
      getRequestContextProvider: () => { current: () => object | null };
      chosenSignIn: () => ChosenSignIn;
      acceptEnvironmentInvitation: (
        environmentId: string,
        chosenBy: ChosenSignIn,
      ) => Promise<EnvironmentInvitationsAcceptResponse>;
    };
    readonly directory: {
      refresh: () => Promise<readonly HostDirectoryEntry[]>;
    };
  } | null,
  directoryRefresh: null as
    | (() => Promise<readonly HostDirectoryEntry[]>)
    | null,
  refreshHostFleet: vi.fn(() => Promise.resolve()),
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

function invitationPress(): {
  readonly request: { readonly environmentId: string };
  readonly chosenBy: ChosenSignIn;
} {
  const binding = mocks.binding;
  if (binding === null) throw new Error("invitation auth was not installed");
  return {
    request: { environmentId: "team-1" },
    chosenBy: binding.auth.chosenSignIn(),
  };
}

function installAuth(
  acceptEnvironmentInvitation: (
    environmentId: string,
    chosenBy: ChosenSignIn,
  ) => Promise<EnvironmentInvitationsAcceptResponse>,
  context: RequestContext,
  directoryRefresh: () => Promise<readonly HostDirectoryEntry[]> = () =>
    Promise.resolve([]),
  switchAfterContextRead: RequestContext | null = null,
): void {
  mocks.currentContext = context;
  mocks.currentUserId = context.identity.userId;
  mocks.identityGeneration = 0;
  mocks.switchAfterContextRead =
    switchAfterContextRead === null
      ? null
      : {
          context: switchAfterContextRead,
          userId: switchAfterContextRead.identity.userId,
          identityGeneration:
            switchAfterContextRead.identity.userId === context.identity.userId
              ? 0
              : 1,
        };
  mocks.directoryRefresh = directoryRefresh;
  const auth = {
    getRequestContextProvider: () => ({
      current: () => {
        const current = mocks.currentContext;
        const next = mocks.switchAfterContextRead;
        if (next !== null) {
          mocks.switchAfterContextRead = null;
          queueMicrotask(() => {
            mocks.currentContext = next.context;
            mocks.currentUserId = next.userId;
            mocks.identityGeneration = next.identityGeneration;
          });
        }
        return current;
      },
    }),
    chosenSignIn: () => ({
      identityGeneration: mocks.identityGeneration,
      userId: mocks.currentUserId,
    }),
    acceptEnvironmentInvitation: async (environmentId, chosenBy) => {
      if (
        chosenBy.identityGeneration !== mocks.identityGeneration ||
        chosenBy.userId !== mocks.currentUserId
      )
        throw new Error("The signed-in account changed.");
      return acceptEnvironmentInvitation(environmentId, chosenBy);
    },
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
    mocks.currentUserId = null;
    mocks.identityGeneration = 0;
    mocks.switchAfterContextRead = null;
    mocks.binding = null;
    mocks.directoryRefresh = null;
    mocks.refreshHostFleet.mockClear();
    seedDoorStates();
  });

  afterEach(() => {
    cleanup();
    queryClient.clear();
    useHostDoorStateStore.setState({ byHost: new Map() });
    mocks.binding = null;
    mocks.directoryRefresh = null;
    mocks.currentContext = null;
    mocks.currentUserId = null;
    mocks.identityGeneration = 0;
    mocks.switchAfterContextRead = null;
  });

  it("refreshes the registered host list after an accepted invitation", async () => {
    const context = createContext("direct-user");
    const accept = vi.fn(() =>
      Promise.resolve({ outcome: "accepted" } as const),
    );
    const directoryRefresh = vi.fn(() => Promise.resolve([]));
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    installAuth(accept, context, directoryRefresh);
    const { result } = renderHook(
      () => useEnvironmentInvitationAcceptMutation(),
      { wrapper: createWrapper(queryClient) },
    );
    const press = invitationPress();

    await act(async () => {
      await result.current.mutateAsync(press);
    });

    expect(accept).toHaveBeenCalledWith("team-1", press.chosenBy);
    expectLocalDoorCleared();
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: authQueryKeys.registeredHostsAll(),
    });
    expect(directoryRefresh).toHaveBeenCalledOnce();
    expect(mocks.refreshHostFleet).toHaveBeenCalledOnce();
  });

  it("does not accept for the new account when identity changes after mutate begins", async () => {
    const accountA = createContext("user-a");
    const accountB = createContext("user-b");
    const sentAs: string[] = [];
    const accept = vi.fn(async (_environmentId: string) => {
      sentAs.push(mocks.currentUserId ?? "none");
      return { outcome: "accepted" as const };
    });
    installAuth(accept, accountA, () => Promise.resolve([]), accountB);
    const { result } = renderHook(
      () => useEnvironmentInvitationAcceptMutation(),
      { wrapper: createWrapper(queryClient) },
    );
    const press = invitationPress();

    await act(async () => {
      await expect(result.current.mutateAsync(press)).rejects.toThrow(
        "The signed-in account changed.",
      );
    });

    expect(accept).not.toHaveBeenCalled();
    expect(sentAs).toEqual([]);
    expectDoorStatesKept();
  });

  it("still accepts after a same-user token rotation in the mutate gap", async () => {
    const accountA = createContext("user-a");
    const rotated = createContext("user-a");
    const sentAs: string[] = [];
    const accept = vi.fn(async (_environmentId: string) => {
      sentAs.push(mocks.currentUserId ?? "none");
      return { outcome: "accepted" as const };
    });
    installAuth(accept, accountA, () => Promise.resolve([]), rotated);
    const { result } = renderHook(
      () => useEnvironmentInvitationAcceptMutation(),
      { wrapper: createWrapper(queryClient) },
    );
    const press = invitationPress();

    await act(async () => {
      await result.current.mutateAsync(press);
    });

    expect(accept).toHaveBeenCalledExactlyOnceWith("team-1", press.chosenBy);
    expect(sentAs).toEqual(["user-a"]);
  });

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
    const press = invitationPress();

    await act(async () => {
      await result.current.mutateAsync(press);
    });

    expectDoorStatesKept();
    expect(invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: authQueryKeys.registeredHostsAll(),
    });
    expect(directoryRefresh).not.toHaveBeenCalled();
    expect(mocks.refreshHostFleet).not.toHaveBeenCalled();
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
        failed.result.current.mutateAsync(invitationPress()),
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
    const switchedPress = invitationPress();
    const mutation: {
      value: Promise<EnvironmentInvitationsAcceptResponse> | null;
    } = { value: null };
    await act(async () => {
      mutation.value = switched.result.current.mutateAsync(switchedPress);
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
  });
});
