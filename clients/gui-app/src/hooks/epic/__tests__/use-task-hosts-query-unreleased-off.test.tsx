/**
 * The build without environments and sandboxes (`unreleased-features.ts`)
 * never asks which hosts a task ran on: the task reads as hostless.
 */
const epicClient = vi.hoisted(() => ({
  current: null as HostRequester<HostRpcRegistry> | null,
}));
vi.mock("@/unreleased-features", () => ({
  UNRELEASED_FEATURES_ENABLED: false,
}));
vi.mock("@/hooks/epic/use-epic-session-host-client", () => ({
  useEpicSessionHostClient: () => epicClient.current,
}));
vi.mock("@/hooks/host/use-reactive-host-readiness", () => ({
  useReactiveHostReadiness: (client: HostRequester<HostRpcRegistry> | null) => {
    const hostId = client === null ? null : client.getActiveHostId();
    return {
      hostId,
      requestContextUserId: VIEWER,
      isReady: hostId !== null,
      hasRpcEndpoint: hostId !== null,
      canExecute: hostId !== null,
    };
  },
}));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HostClient,
  type HostRequester,
} from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { useTaskHostsView } from "@/hooks/epic/use-task-hosts-view";
import { useAuthStore } from "@/stores/auth/auth-store";

const VIEWER = "user-1";

afterEach(() => {
  cleanup();
  epicClient.current = null;
  useAuthStore.setState(useAuthStore.getInitialState(), true);
});

describe("useTaskHostsView without environments", () => {
  it("sends no epic.listTaskHosts for an authorized viewer and reads none", async () => {
    useAuthStore.setState({
      status: "signed-in",
      contextMetadata: { userId: VIEWER, username: VIEWER },
    });
    const asked: string[] = [];
    const spine = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      invalidator: { invalidateHostScope: () => undefined },
      findHostById: (hostId) =>
        hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
      messenger: new MockHostMessenger<HostRpcRegistry>({
        registry: hostRpcRegistry,
        requestId: () => "req",
        handlers: {
          "epic.listTaskHosts": () => {
            asked.push("epic.listTaskHosts");
            return { hosts: [] };
          },
        },
      }),
    });
    spine.setRequestContext(
      createRequestContextFixture({
        identity: { userId: VIEWER, username: VIEWER, providerHandle: null },
        origin: "renderer",
      }),
    );
    epicClient.current = spine.createRequester(mockLocalHostEntry);
    const wrapper = (props: { readonly children: ReactNode }): ReactNode => (
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        {props.children}
      </QueryClientProvider>
    );

    const { result } = renderHook(() => useTaskHostsView("epic-1"), {
      wrapper,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(asked).toEqual([]);
    expect(result.current).toEqual({ kind: "none" });
  });
});
