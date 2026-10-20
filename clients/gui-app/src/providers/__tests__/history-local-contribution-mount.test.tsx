import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { HistoryLocalContributionMount } from "@/providers/history-local-contribution-mount";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";
import {
  __resetHistoryContributionsForTests,
  unfilteredHistoryContribution,
} from "@/lib/history-composition/history-local-contribution";
import { useAuthStore } from "@/stores/auth/auth-store";

const ACCOUNT = "account-1";
const HOST_ID = mockLocalHostEntry.hostId;

const clientRef = vi.hoisted(() => ({
  current: null as HostClient<HostRpcRegistry> | null,
}));

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => clientRef.current,
}));
vi.mock("@/hooks/host/use-reactive-host-readiness", () => ({
  useReactiveHostReadiness: () => ({
    hostId: HOST_ID,
    requestContextUserId: ACCOUNT,
    isReady: true,
    hasRpcEndpoint: true,
    canExecute: true,
  }),
}));

describe("HistoryLocalContributionMount", () => {
  let reads = 0;

  beforeEach(() => {
    reads = 0;
    __resetHistoryContributionsForTests();
    useAuthStore.setState({
      status: "signed-in",
      contextMetadata: { userId: ACCOUNT, username: ACCOUNT },
    });
    const queryClient = createAppQueryClient();
    const spine = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      invalidator: createHostQueryInvalidator(queryClient),
      findHostById: (hostId) =>
        hostId === HOST_ID ? mockLocalHostEntry : null,
      messenger: new MockHostMessenger<HostRpcRegistry>({
        registry: hostRpcRegistry,
        requestId: () => "mount",
        handlers: {
          "epic.localHistory.read": () => {
            reads += 1;
            return new Promise<never>(() => undefined);
          },
        },
      }),
    });
    spine.setRequestContext(
      createRequestContextFixture({
        identity: { userId: ACCOUNT, username: ACCOUNT, providerHandle: null },
        origin: "renderer",
      }),
    );
    clientRef.current = spine.createRequester(mockLocalHostEntry);
  });

  afterEach(() => {
    cleanup();
    clientRef.current = null;
    __resetHistoryContributionsForTests();
    useAuthStore.setState(useAuthStore.getInitialState(), true);
  });

  it("holds the paint while its read is in flight and gives the scope back when unmounted before it resolves", async () => {
    const first = render(<HistoryLocalContributionMount />);
    await vi.waitFor(() => {
      expect(reads).toBe(1);
    });
    expect(unfilteredHistoryContribution(ACCOUNT, HOST_ID)).toEqual({
      kind: "pending",
    });

    first.unmount();
    expect(unfilteredHistoryContribution(ACCOUNT, HOST_ID)).toBeUndefined();

    render(<HistoryLocalContributionMount />);
    await vi.waitFor(() => {
      expect(reads).toBe(2);
    });
  });
});
