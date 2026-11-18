import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import {
  HostClient,
  type HostRequester,
} from "@traycer-clients/shared/host-client/host-client";
import {
  mockLocalHostEntry,
  mockRemoteHostEntry,
} from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { HostRpcRegistry } from "@/lib/host";
import type { StreamRuntimeBinding } from "@/lib/host/stream-runtime-context";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import type { SessionImportStatusResponse } from "@traycer/protocol/host/session-import/contracts";
import { sessionImportQueryKeys } from "@/lib/query-keys";
import { useSessionImportCheckStatus } from "../use-session-import-check-status-query";

type StatusResponse = ResponseOfMethod<HostRpcRegistry, "sessionImport.status">;

interface RuntimeHarness {
  client: HostRequester<HostRpcRegistry> | null;
  hostId: string;
}

const runtime = vi.hoisted((): RuntimeHarness => ({
  client: null,
  hostId: "host-a",
}));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => runtime.client,
}));

vi.mock("@/hooks/host/use-reactive-host-readiness", () => ({
  useReactiveHostReadiness: () => ({
    hostId: runtime.hostId,
    requestContextUserId: "test-user",
    isReady: true,
    hasRpcEndpoint: true,
    canExecute: true,
  }),
}));

function idleStatus(): SessionImportStatusResponse {
  return { active: null, lastCompleted: null };
}

function activeStatus(runId: string): SessionImportStatusResponse {
  return {
    active: { runId, done: 1, total: 2 },
    lastCompleted: null,
  };
}

function fakeStreamClient(
  instanceId: string,
): IHostStreamClient<HostStreamRpcRegistry> {
  return {
    subscribe: () => {
      throw new Error("stream is not exercised by this hook");
    },
    subscribeWithParamsProvider: () => {
      throw new Error("stream is not exercised by this hook");
    },
    close: () => undefined,
    isClosed: () => false,
    isReady: () => true,
    getClosedReason: () => null,
    onClosed: () => () => undefined,
    instanceId,
    notifyBearerRotated: () => undefined,
    notifyCloudVerdictChanged: () => undefined,
    reconnectAll: () => undefined,
    getMethodSupport: () => "unknown",
    subscribeMethodSupport: () => () => undefined,
    getMethodSchemaVersion: () => null,
    subscribeAvailabilityRecovered: () => () => undefined,
  };
}

function binding(hostId: string, instanceId: string): StreamRuntimeBinding {
  return { wsStreamClient: fakeStreamClient(instanceId), hostId, retain: null };
}

function createClient(
  hostId: string,
  response: () => StatusResponse | Promise<StatusResponse>,
  onRequest: (hostId: string) => void,
): HostRequester<HostRpcRegistry> {
  const entry = {
    ...(hostId === "host-a" ? mockLocalHostEntry : mockRemoteHostEntry),
    hostId,
  };
  let requestNumber = 0;
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => `status-${hostId}-${String((requestNumber += 1))}`,
    handlers: {
      "sessionImport.status": () => {
        onRequest(hostId);
        return response();
      },
    },
  });
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => undefined },
    findHostById: (requestedHostId) =>
      requestedHostId === hostId ? entry : null,
    messenger,
  });
  client.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "token" }),
  );
  return client.createRequester(entry);
}

function makeWrapper(queryClient: QueryClient) {
  return ({ children }: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe("useSessionImportCheckStatus", () => {
  afterEach(() => {
    cleanup();
    runtime.client = null;
    runtime.hostId = "host-a";
  });

  it("asks the named host again after a transport switch and ignores a cached Settings idle snapshot", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const responses: StatusResponse[] = [idleStatus()];
    const requests: string[] = [];
    let resolveFirst: (response: StatusResponse) => void = () => undefined;
    const firstResponse = new Promise<StatusResponse>((resolve) => {
      resolveFirst = resolve;
    });
    let requestNumber = 0;
    runtime.client = createClient(
      "host-a",
      () => {
        if (requestNumber === 0) {
          requestNumber += 1;
          return firstResponse;
        }
        const response = responses.shift();
        if (response === undefined) {
          throw new Error("unexpected status request");
        }
        return response;
      },
      (requestedHostId) => requests.push(requestedHostId),
    );

    // This is the Settings query's old shared key. The wizard's useId and
    // transport instance must keep it from authorizing an idle answer here.
    queryClient.setQueryData(
      sessionImportQueryKeys.status("host-a"),
      idleStatus(),
    );

    let currentBinding = binding("host-a", "stream-a");
    const rendered = renderHook(
      () =>
        // The hook result remains a complete UseQueryResult, so the test
        // observes TanStack's real pending/success transitions.
        useSessionImportCheckStatus(currentBinding, true),
      { wrapper: makeWrapper(queryClient) },
    );

    expect(rendered.result.current.isPending).toBe(true);
    act(() => {
      resolveFirst(activeStatus("run-from-host"));
    });
    await waitFor(() => expect(rendered.result.current.isSuccess).toBe(true));
    expect(rendered.result.current.data?.active?.runId).toBe("run-from-host");

    act(() => {
      currentBinding = binding("host-a", "stream-b");
      rendered.rerender();
    });

    await waitFor(() => {
      expect(rendered.result.current.isSuccess).toBe(true);
      expect(rendered.result.current.data?.active).toBeNull();
    });
    expect(requests).toEqual(["host-a", "host-a"]);
  });

  it("checks the host again when the wizard is reopened", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const requests: string[] = [];
    runtime.client = createClient(
      "host-a",
      () => activeStatus("run-reopened"),
      (requestedHostId) => requests.push(requestedHostId),
    );
    let currentBinding = binding("host-a", "stream-a");
    const wrapper = makeWrapper(queryClient);
    const first = renderHook(
      () => useSessionImportCheckStatus(currentBinding, true),
      { wrapper },
    );
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
    first.unmount();

    // Settings may have a cached idle snapshot between visits. A reopened
    // wizard gets a new useId and must still observe the host's active run.
    queryClient.setQueryData(
      sessionImportQueryKeys.status("host-a"),
      idleStatus(),
    );
    currentBinding = binding("host-a", "stream-a");
    const reopened = renderHook(
      () => useSessionImportCheckStatus(currentBinding, true),
      { wrapper },
    );
    await waitFor(() => expect(reopened.result.current.isSuccess).toBe(true));

    expect(reopened.result.current.data?.active?.runId).toBe("run-reopened");
    expect(requests).toEqual(["host-a", "host-a"]);
  });
});
