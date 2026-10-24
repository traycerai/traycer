/**
 * The machine lists of several team environments on one client (Tracy Bots):
 * an environment whose list was refused is named failed and stays out of the
 * answered map (so a reader can tell "could not read" from "no machine"), and
 * `retryFailed` asks the failed ones again without re-asking the answered.
 *
 * Real hook over a mock messenger whose handler can refuse.
 */
import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  HostClient,
  type HostRequester,
} from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { EnvironmentHostRecordV11 } from "@traycer/protocol/host/environment/contracts";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import {
  useEnvironmentHostLists,
  type EnvironmentHostLists,
} from "@/hooks/bots/use-environment-host-lists-query";

vi.mock("@/hooks/host/use-reactive-host-readiness", () => ({
  useReactiveHostReadiness: (client: HostRequester<HostRpcRegistry> | null) => {
    const hostId = client === null ? null : client.getActiveHostId();
    return {
      hostId,
      requestContextUserId: "user-1",
      isReady: hostId !== null,
      hasRpcEndpoint: hostId !== null,
      canExecute: hostId !== null,
    };
  },
}));

const FLAKY = "env-flaky";
const STEADY = "env-steady";

function machine(hostId: string): EnvironmentHostRecordV11 {
  return {
    hostId,
    hostLabel: hostId,
    hostPlatform: null,
    enrolledByUserId: "user-1",
    kind: "sandbox",
    boundAt: 1,
    reachable: true,
    lastReportedAt: null,
    applied: [],
  };
}

function mountLists(flakyAnswersFromStart: boolean): {
  readonly lists: () => EnvironmentHostLists;
  readonly reads: () => Readonly<Record<string, number>>;
  readonly healFlaky: () => void;
  readonly breakFlaky: () => void;
  readonly refetchFlaky: () => Promise<void>;
} {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const reads: Record<string, number> = {};
  let flakyAnswers = flakyAnswersFromStart;
  let seq = 0;
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => `req-${String(++seq)}`,
    handlers: {
      "environment.host.list": ({ environmentId }) => {
        reads[environmentId] = (reads[environmentId] ?? 0) + 1;
        if (environmentId === FLAKY && !flakyAnswers) {
          throw new Error("refused");
        }
        return { hosts: [machine(`host-in-${environmentId}`)] };
      },
    },
  });
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger,
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  const client = spine.createRequester(mockLocalHostEntry);
  const wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
  const { result } = renderHook(
    () => useEnvironmentHostLists(client, [FLAKY, STEADY], true),
    { wrapper },
  );
  return {
    lists: () => result.current,
    reads: () => ({ ...reads }),
    healFlaky: () => {
      flakyAnswers = true;
    },
    breakFlaky: () => {
      flakyAnswers = false;
    },
    // An invalidation-driven refetch of FLAKY's list only: the query keeps
    // its last answer in `data` while the refetch fails.
    refetchFlaky: () =>
      queryClient.invalidateQueries({
        predicate: ({ queryKey }) => {
          if (
            !hostQueryKeys.matchesMethodOnAnyHost(
              queryKey,
              "environment.host.list",
            )
          ) {
            return false;
          }
          const params = queryKey[3];
          return (
            typeof params === "object" &&
            params !== null &&
            "environmentId" in params &&
            params.environmentId === FLAKY
          );
        },
      }),
  };
}

describe("useEnvironmentHostLists", () => {
  it("names a refused environment failed and leaves it out of the answered map", async () => {
    const mounted = mountLists(false);

    await waitFor(() => {
      expect(mounted.lists().failedEnvironmentIds).toEqual(new Set([FLAKY]));
      expect(mounted.lists().hostsByEnvironmentId.has(STEADY)).toBe(true);
    });
    expect(mounted.lists().hostsByEnvironmentId.has(FLAKY)).toBe(false);
  });

  it("retries only the failed environments, and an answer clears the failure", async () => {
    const mounted = mountLists(false);
    await waitFor(() => {
      expect(mounted.lists().failedEnvironmentIds.has(FLAKY)).toBe(true);
    });
    expect(mounted.reads()).toEqual({ [FLAKY]: 1, [STEADY]: 1 });

    mounted.healFlaky();
    act(() => {
      mounted.lists().retryFailed();
    });

    await waitFor(() => {
      expect(
        mounted
          .lists()
          .hostsByEnvironmentId.get(FLAKY)
          ?.map((host) => host.hostId),
      ).toEqual([`host-in-${FLAKY}`]);
    });
    expect(mounted.lists().failedEnvironmentIds.size).toBe(0);
    expect(mounted.reads()).toEqual({ [FLAKY]: 2, [STEADY]: 1 });
  });

  it("treats a failed refetch of an answered list as failed, not as its stale answer", async () => {
    const mounted = mountLists(true);
    await waitFor(() => {
      expect([...mounted.lists().hostsByEnvironmentId.keys()].sort()).toEqual([
        FLAKY,
        STEADY,
      ]);
    });
    expect(mounted.lists().failedEnvironmentIds.size).toBe(0);
    expect(mounted.reads()).toEqual({ [FLAKY]: 1, [STEADY]: 1 });

    mounted.breakFlaky();
    await act(async () => {
      await mounted.refetchFlaky();
    });

    await waitFor(() => {
      expect(mounted.lists().failedEnvironmentIds).toEqual(new Set([FLAKY]));
    });
    expect(mounted.lists().hostsByEnvironmentId.has(FLAKY)).toBe(false);
    expect(mounted.lists().hostsByEnvironmentId.has(STEADY)).toBe(true);
    expect(mounted.reads()).toEqual({ [FLAKY]: 2, [STEADY]: 1 });

    mounted.healFlaky();
    act(() => {
      mounted.lists().retryFailed();
    });

    await waitFor(() => {
      expect(mounted.lists().hostsByEnvironmentId.has(FLAKY)).toBe(true);
    });
    expect(mounted.lists().failedEnvironmentIds.size).toBe(0);
    expect(mounted.lists().hostsByEnvironmentId.has(STEADY)).toBe(true);
    expect(mounted.reads()).toEqual({ [FLAKY]: 3, [STEADY]: 1 });
  });
});
