import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { HostTransportFailureError } from "@traycer-clients/shared/host-transport/host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { useCloudChatList } from "@/hooks/chats/use-cloud-chat-queries";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";
import { useAuthStore } from "@/stores/auth/auth-store";

const TASK_ID = "epic-restart";

interface Fixture {
  readonly client: HostClient<HostRpcRegistry>;
  readonly queryClient: QueryClient;
  readonly requests: { value: number };
  readonly Wrapper: (props: { readonly children: ReactNode }) => ReactNode;
}

function transientListError(requestId: string): HostTransportFailureError {
  return new HostTransportFailureError({
    code: "RPC_ERROR",
    message: "cloud list temporarily unavailable",
    requestId,
    method: "epic.listCloudChats",
    fatalDetails: null,
  });
}

function createFixture(succeedsOnRequest: number): Fixture {
  const requests = { value: 0 };
  const queryClient = createAppQueryClient();
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => `cloud-list-${String(requests.value + 1)}`,
      handlers: {
        "epic.listCloudChats": () => {
          requests.value += 1;
          if (requests.value < succeedsOnRequest) {
            return Promise.reject(
              transientListError(`cloud-list-${String(requests.value)}`),
            );
          }
          return Promise.resolve({ chats: [] });
        },
      },
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  const client = spine.createRequester(mockLocalHostEntry);
  const Wrapper = (props: { readonly children: ReactNode }): ReactNode =>
    createElement(QueryClientProvider, { client: queryClient }, props.children);
  return { client, queryClient, requests, Wrapper };
}

describe("useCloudChatList recovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useAuthStore.setState({
      contextMetadata: { userId: "viewer-1", username: "viewer-1" },
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    useAuthStore.setState(useAuthStore.getInitialState(), true);
  });

  it("recovers from a transient startup failure without reopening the tab", async () => {
    const fixture = createFixture(4);
    const rendered = renderHook(
      () =>
        useCloudChatList({
          client: fixture.client,
          taskId: TASK_ID,
          enabled: true,
        }),
      { wrapper: fixture.Wrapper },
    );

    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (rendered.result.current.isSuccess) break;
      await flushTimers(30_000);
    }

    expect(fixture.requests.value).toBe(4);
    expect(rendered.result.current.data).toEqual({ chats: [] });
  });

  it("refetches immediately when the host transport reports recovery", async () => {
    const fixture = createFixture(2);
    const rendered = renderHook(
      () =>
        useCloudChatList({
          client: fixture.client,
          taskId: TASK_ID,
          enabled: true,
        }),
      { wrapper: fixture.Wrapper },
    );

    await flushTimers(0);
    expect(fixture.requests.value).toBe(1);

    // No retry-delay time passes. The HostClient's recovery signal invalidates
    // the active host scope and the list asks again immediately.
    fixture.client.notifyHostAvailabilityRecovered(mockLocalHostEntry.hostId);
    await flushTimers(0);

    expect(fixture.requests.value).toBe(2);
    expect(rendered.result.current.data).toEqual({ chats: [] });
  });
});

async function flushTimers(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
