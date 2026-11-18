import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import {
  HostRpcError,
  HostTransportFailureError,
  isTransientHostRpcFailure,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import { createAppQueryClient } from "@/lib/query-client";
import { useAuthStore } from "@/stores/auth/auth-store";

interface HostQueryCall {
  readonly method: string;
  readonly params: { readonly taskId: string };
  readonly client: object | null;
  readonly cacheKeyIdentity: readonly string[];
  readonly preflight: () => void;
  readonly options: {
    readonly enabled: boolean;
    readonly staleTime: number;
    readonly retry: (failureCount: number, error: HostRpcError) => boolean;
  };
}

const mocks = vi.hoisted(() => ({
  viewerId: "u-viewer",
  cloudAuthorized: true,
  calls: [] as HostQueryCall[],
}));

vi.mock("@/hooks/chats/use-cloud-chat-queries", () => ({
  useCloudChatViewerId: () => mocks.viewerId,
  useCloudChatHasCloudAuthorization: () => mocks.cloudAuthorized,
}));
vi.mock("@/hooks/host/use-host-query", () => ({
  useHostQuery: (call: HostQueryCall) => {
    mocks.calls.push(call);
    return { data: undefined, isPending: true };
  },
}));

import { useTaskHosts } from "@/hooks/epic/use-task-hosts-query";

/** A real client with nothing behind it: the hook only passes it on. */
function makeClient(): HostClient<HostRpcRegistry> {
  return new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    schedulingPolicy: hostRpcSchedulingPolicy,
    invalidator: createHostQueryInvalidator(createAppQueryClient()),
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-test",
      handlers: {},
    }),
  });
}

function lastCall(): HostQueryCall {
  const call = mocks.calls.at(-1);
  if (call === undefined) throw new Error("useHostQuery was not called");
  return call;
}

function rpcError(code: "E_HOST_UNSUPPORTED" | "FORBIDDEN"): HostRpcError {
  return new HostRpcError({
    code,
    message: "refused",
    requestId: "req-1",
    method: "epic.listTaskHosts",
    fatalDetails: null,
  });
}

function transportError(): HostRpcError {
  return new HostTransportFailureError({
    code: "RPC_ERROR",
    message: "Lost the connection to this computer.",
    requestId: "req-2",
    method: "epic.listTaskHosts",
    fatalDetails: null,
  });
}

beforeEach(() => {
  mocks.viewerId = "u-viewer";
  mocks.cloudAuthorized = true;
  mocks.calls.length = 0;
});

afterEach(() => {
  cleanup();
  useAuthStore.setState({ status: "signed-out" });
});

describe("useTaskHosts", () => {
  it("asks epic.listTaskHosts for the task, through the client it is given", () => {
    const client = makeClient();
    renderHook(() => useTaskHosts(client, "epic-1"));

    const call = lastCall();
    expect(call.method).toBe("epic.listTaskHosts");
    expect(call.params).toEqual({ taskId: "epic-1" });
    expect(call.client).toBe(client);
  });

  it("keys the cache by the viewer, since the answer is filtered per viewer", () => {
    renderHook(() => useTaskHosts(null, "epic-1"));

    expect(lastCall().cacheKeyIdentity).toEqual(["u-viewer"]);
  });

  it("re-reads the cloud verdict at dispatch with a preflight", () => {
    renderHook(() => useTaskHosts(null, "epic-1"));

    expect(typeof lastCall().preflight).toBe("function");
  });

  it("refuses to dispatch when the session holds no cloud verdict, naming epic.listTaskHosts", () => {
    renderHook(() => useTaskHosts(null, "epic-1"));
    const { preflight } = lastCall();

    for (const status of ["signed-out", "signing-in", "unverified"] as const) {
      useAuthStore.setState({ status });
      let refusal: unknown = null;
      try {
        preflight();
      } catch (error) {
        refusal = error;
      }
      expect(refusal, status).toBeInstanceOf(HostRpcError);
      if (!(refusal instanceof HostRpcError)) {
        throw new Error("expected a HostRpcError");
      }
      expect(refusal.method, status).toBe("epic.listTaskHosts");
      expect(refusal.message, status).toContain("cloud verdict");
      expect(isTransientHostRpcFailure(refusal), status).toBe(false);
    }
  });

  it("lets the dispatch through while the session holds a cloud verdict", () => {
    renderHook(() => useTaskHosts(null, "epic-1"));
    useAuthStore.setState({ status: "signed-in" });

    expect(() => lastCall().preflight()).not.toThrow();
  });

  it("reads the verdict live, at each call, not when the hook rendered", () => {
    useAuthStore.setState({ status: "signed-in" });
    renderHook(() => useTaskHosts(null, "epic-1"));
    const { preflight } = lastCall();
    expect(() => preflight()).not.toThrow();

    useAuthStore.setState({ status: "unverified" });

    expect(() => preflight()).toThrow(HostRpcError);
  });

  it("is enabled when cloud is authorized and the task id and viewer id are present", () => {
    renderHook(() => useTaskHosts(null, "epic-1"));

    expect(lastCall().options.enabled).toBe(true);
  });

  it("is disabled without cloud authorization", () => {
    mocks.cloudAuthorized = false;
    renderHook(() => useTaskHosts(null, "epic-1"));

    expect(lastCall().options.enabled).toBe(false);
  });

  it("is disabled for an empty task id", () => {
    renderHook(() => useTaskHosts(null, ""));

    expect(lastCall().options.enabled).toBe(false);
  });

  it("is disabled for an empty viewer id", () => {
    mocks.viewerId = "";
    renderHook(() => useTaskHosts(null, "epic-1"));

    expect(lastCall().options.enabled).toBe(false);
  });

  it("passes a missing client on as null, still keyed by the viewer", () => {
    renderHook(() => useTaskHosts(null, "epic-1"));

    expect(lastCall().client).toBeNull();
    expect(lastCall().cacheKeyIdentity).toEqual(["u-viewer"]);
  });

  it("retries a transport failure only: a missing method and a refusal are terminal", () => {
    renderHook(() => useTaskHosts(null, "epic-1"));
    const { retry } = lastCall().options;

    expect(typeof retry).toBe("function");
    expect(retry(0, transportError())).toBe(true);
    expect(retry(0, rpcError("E_HOST_UNSUPPORTED"))).toBe(false);
    expect(retry(0, rpcError("FORBIDDEN"))).toBe(false);
  });
});
