import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { RequestContext } from "@traycer/protocol/auth/request-context";
import type { EnvironmentInvitationsAcceptResponse } from "@traycer/protocol/host/environment/contracts";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
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
const rpcHostId = "invitation-rpc-host";

const mocks = vi.hoisted(() => ({
  localHostId: null as string | null,
  methodSupport: false,
  currentContext: null as object | null,
  binding: null as {
    readonly auth: {
      getRequestContextProvider: () => { current: () => object | null };
      acceptEnvironmentInvitation: (
        environmentId: string,
      ) => Promise<EnvironmentInvitationsAcceptResponse>;
    };
  } | null,
}));

vi.mock("@/lib/host", () => ({
  useHostBinding: () => mocks.binding,
  useHostClient: () => null,
}));

vi.mock("@/lib/host/local-host-id-snapshot", () => ({
  readLocalHostIdSnapshot: () => mocks.localHostId,
}));

vi.mock("@/hooks/chats/use-cloud-chat-queries", () => ({
  useCloudChatViewerId: () => "invitation-user",
}));

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: () => mocks.methodSupport,
}));

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({ hostManagement: null }),
}));

const localEntry: HostDirectoryEntry = {
  hostId: rpcHostId,
  label: "Invitation host",
  kind: "local",
  websocketUrl: "ws://127.0.0.1:4917/rpc",
  version: "test",
  transportDialability: "dialable",
};

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
): void {
  mocks.currentContext = context;
  const auth = {
    getRequestContextProvider: () => ({
      current: () => mocks.currentContext,
    }),
    acceptEnvironmentInvitation,
  };
  mocks.binding = { auth };
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

function createRpcClient(
  queryClient: QueryClient,
  context: RequestContext,
  answer: EnvironmentInvitationsAcceptResponse,
): HostClient<HostRpcRegistry> {
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => "invitation-request",
    handlers: {
      "environment.invitations.accept": () => Promise.resolve(answer),
    },
  });
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hostId === localEntry.hostId ? localEntry : null,
    messenger,
  });
  spine.setRequestContext(context);
  return spine.createRequester(localEntry);
}

describe("invitation acceptance clears the local host door state", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = createQueryClient();
    useHostDoorStateStore.setState({ byHost: new Map() });
    mocks.localHostId = localHostId;
    mocks.methodSupport = false;
    mocks.currentContext = null;
    mocks.binding = null;
    seedDoorStates();
  });

  afterEach(() => {
    cleanup();
    queryClient.clear();
    useHostDoorStateStore.setState({ byHost: new Map() });
    mocks.binding = null;
    mocks.currentContext = null;
  });

  it("invalidates after a direct accepted invitation", async () => {
    const context = createContext("direct-user");
    const accept = vi.fn(() =>
      Promise.resolve({ outcome: "accepted" } as const),
    );
    installAuth(accept, context);
    const { result } = renderHook(
      () => useEnvironmentInvitationAcceptMutation(null),
      { wrapper: createWrapper(queryClient) },
    );

    await act(async () => {
      await result.current.mutateAsync({ environmentId: "team-1" });
    });

    expect(accept).toHaveBeenCalledWith("team-1");
    expectLocalDoorCleared();
  });

  it("does not invalidate after a direct invitation was not found", async () => {
    const context = createContext("direct-user");
    installAuth(() => Promise.resolve({ outcome: "not_found" }), context);
    const { result } = renderHook(
      () => useEnvironmentInvitationAcceptMutation(null),
      { wrapper: createWrapper(queryClient) },
    );

    await act(async () => {
      await result.current.mutateAsync({ environmentId: "team-1" });
    });

    expectDoorStatesKept();
  });

  it("invalidates after an RPC accepted invitation", async () => {
    mocks.methodSupport = true;
    const context = createContext("rpc-user");
    installAuth(() => Promise.resolve({ outcome: "not_found" }), context);
    const client = createRpcClient(queryClient, context, {
      outcome: "accepted",
    });
    const { result } = renderHook(
      () => useEnvironmentInvitationAcceptMutation(client),
      { wrapper: createWrapper(queryClient) },
    );

    await act(async () => {
      await result.current.mutateAsync({ environmentId: "team-1" });
    });

    expectLocalDoorCleared();
  });

  it("does not invalidate after an RPC invitation was not found", async () => {
    mocks.methodSupport = true;
    const context = createContext("rpc-user");
    installAuth(() => Promise.resolve({ outcome: "accepted" }), context);
    const client = createRpcClient(queryClient, context, {
      outcome: "not_found",
    });
    const { result } = renderHook(
      () => useEnvironmentInvitationAcceptMutation(client),
      { wrapper: createWrapper(queryClient) },
    );

    await act(async () => {
      await result.current.mutateAsync({ environmentId: "team-1" });
    });

    expectDoorStatesKept();
  });

  it("does not invalidate on failure or when the account context changes before success", async () => {
    const failureContext = createContext("failure-user");
    const rejectAccept = vi.fn(() =>
      Promise.reject(new Error("request failed")),
    );
    installAuth(rejectAccept, failureContext);
    const failed = renderHook(
      () => useEnvironmentInvitationAcceptMutation(null),
      { wrapper: createWrapper(queryClient) },
    );

    await act(async () => {
      await expect(
        failed.result.current.mutateAsync({ environmentId: "team-1" }),
      ).rejects.toThrow("request failed");
    });
    expectDoorStatesKept();
    failed.unmount();

    const accountChangeContext = createContext("before-switch");
    const pending = deferred<EnvironmentInvitationsAcceptResponse>();
    const acceptStarted = deferred<void>();
    installAuth(() => {
      acceptStarted.resolve();
      return pending.promise;
    }, accountChangeContext);
    const switched = renderHook(
      () => useEnvironmentInvitationAcceptMutation(null),
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
  });
});
